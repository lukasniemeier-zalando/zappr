import { logger } from '../../common/debug'
const log = logger('approval')

export default class Approval {
  static get type() {
    return 'approval'
  }

  static get hookEvents() {
    return ['pull_request', 'issue_comment']
  }

  static generateStatusMessage(actual, needed) {
    if (actual < needed) {
      return `This PR needs ${needed - actual} more approvals (${actual}/${needed} given).`
    }
    return `This PR has ${actual}/${needed} approvals since the last commit.`
  }

  static async countApprovals(github, repository, comments, config, token) {
    const {pattern} = config
    let filtered = comments
                    // get comments that match specified approval pattern
                    .filter(c => (new RegExp(pattern)).test(c.body) !== -1)
                    // slightly unperformant filtering here:
                    // kicking out multiple approvals from same person
                    .filter((c1, i, cmts) => i === cmts.findIndex(c2 => c1.user.login === c2.user.login))
    // don't proceed if nothing is left
    if (filtered.length === 0) {
      return 0
    }
    // we now have approvals from a set of persons
    // check membership requirements
    if (config.from) {
      const {orgs, collaborators, users} = config.from
      // persons must either be listed explicitly in users OR
      // be a collaborator OR
      // member of at least one of listed orgs
      filtered = await Promise.all(filtered.map(async (comment) => {
        const username = comment.user.login
        // first do the quick username check
        if (users && users.indexOf(username) >= 0) {
          return Promise.resolve(comment)
        }
        // now collaborators
        if (collaborators) {
          const isCollaborator = await github.isCollaborator(repository.owner.login, repository.name, username, token)
          if (isCollaborator) {
            return Promise.resolve(comment)
          }
        }
        // and orgs
        if (orgs) {
          const orgMember = await Promise.all(orgs.map(o => github.isMemberOfOrg(o, username, token)))
          if (orgMember.indexOf(true) >= 0) {
            return Promise.resolve(comment)
          }
        }
        // okay, no member of anything
        return Promise.resolve(null)
      }))
      // return count non-null comments
      return filtered.filter(c => !!c).length
    } else {
      return filtered.length
    }
  }

  /**
   * - PR open/reopen:
   *   1. set status to pending
   *   2. count approvals since last commit
   *   3. set status to ok or fail
   * - IssueComment create/delete:
   *   1. verify it's on an open pull request
   *   2. set status to pending for open PR
   *   3. count approvals since last commit
   *   4. set status to ok or fail
   * - PR synchronize:
   *   1. set status to fail (b/c there can't be comments afterwards already)
   */

  static async execute(github, config, hookPayload, token, dbRepoId, pullRequestHandler) {
    const {action, repository, pull_request, number, issue} = hookPayload
    const repo = repository.name
    const user = repository.owner.login
    const {minimum} = config.approvals
    let sha = ''
    const pendingPayload = {
      state: 'pending',
      description: 'ZAPPR validation in progress.',
      context: 'zappr'
    }
    try {
      // on an open pull request
      if (!!pull_request && pull_request.state === 'open') {
        // if it was (re)opened
        if (action === 'opened' || action === 'reopened') {
          // set status to pending first
          sha = pull_request.head.sha
          await github.setCommitStatus(user, repo, pull_request.head.sha, pendingPayload, token)
          if (action === 'opened' && minimum > 0) {
            // if it was opened, create pr in our db and set to fail
            await pullRequestHandler.onCreatePullRequest(dbRepoId, number)
            await github.setCommitStatus(user, repo, pull_request.head.sha, {
              state: 'failure',
              description: this.generateStatusMessage(0, minimum),
              context: 'zappr'
            }, token)
            return
          }
          // get approvals for pr
          const comments = await github.getComments(user, repo, number, null, token)
          const approvals = await this.countApprovals(github, repository, comments, config.approvals, token)
          let status = {
            state: approvals < minimum ? 'failure' : 'success',
            context: 'zappr',
            description: this.generateStatusMessage(approvals, minimum)
          }
          // update status
          await github.setCommitStatus(user, repo, pull_request.head.sha, status, token)
        // if it was synced, ie a commit added to it
        } else if (action === 'synchronize') {
          // update last push in db
          await pullRequestHandler.onAddCommit(dbRepoId, number)
          // set status to failure (has to be unlocked with further comments)
          await github.setCommitStatus(user, repo, pull_request.head.sha, {
            state: 'failure',
            description: this.generateStatusMessage(0, minimum),
            context: 'zappr'
          }, token)
        }
      // on an issue comment
      } else if (!!issue) {
        // check it belongs to an open pr
        const pr = await github.getPullRequest(user, repo, issue.number, token)
        if (!pr || pr.state !== 'open') {
          return
        }
        sha = pr.head.sha
        // set status to pending first
        await github.setCommitStatus(user, repo, pr.head.sha, pendingPayload, token)
        // read last push date from db
        const dbPR = await pullRequestHandler.onGet(dbRepoId, issue.number)
        // get approval count
        const comments = await github.getComments(user, repo, issue.number, github.formatDate(dbPR.last_push), token)
        const approvals = await this.countApprovals(github, repository, comments, config.approvals, token)
        let status = {
          state: approvals < minimum ? 'failure' : 'success',
          context: 'zappr',
          description: this.generateStatusMessage(approvals, minimum)
        }
        // update status
        await github.setCommitStatus(user, repo, pr.head.sha, status, token)
      }
    }
    catch(e) {
      log(e)
      await github.setCommitStatus(user, repo, sha, {
        state: 'error',
        context: 'zappr',
        description: e.message
      }, token)
    }
  }
}
