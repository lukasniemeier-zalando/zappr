import Check from './Check'
import { logger, formatDate } from '../../common/debug'
import * as EVENTS from '../model/GithubEvents'

const context = 'zappr'
const info = logger('approval', 'info')
const debug = logger('approval')
const error = logger('approval', 'error')

export default class Approval extends Check {

  static TYPE = 'approval'
  static NAME = 'Approval check'
  static HOOK_EVENTS = [EVENTS.PULL_REQUEST, EVENTS.ISSUE_COMMENT]

  static generateStatusMessage(actual, needed) {
    if (actual < needed) {
      return `This PR needs ${needed - actual} more approvals (${actual}/${needed} given).`
    }
    return `This PR has ${actual}/${needed} approvals since the last commit.`
  }

  static async countApprovals(github, repository, comments, config, token) {

    const {pattern, ignore} = config

    const fullName = `${repository.full_name}`
    let filtered = comments
                    // filter ignored users
                    .filter(comment => {
                       const {login} = comment.user
                       const include = (ignore || []).indexOf(login) === -1
                       if (!include) info('%s: Ignoring user: %s.', fullName, login)
                       return include
                    })
                    // get comments that match specified approval pattern
                    // TODO add unicode flag once available in node
                    .filter(comment => {
                      const text = comment.body.trim()
                      const include = (new RegExp(pattern)).test(text)
                      if (!include) info('%s: Comment "%s" does not match pattern "%s".', fullName, text, pattern)
                      return include
                    })
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
          debug(`${fullName}: ${username} is listed explicitly`)
          return Promise.resolve(comment)
        }
        // now collaborators
        if (collaborators) {
          const isCollaborator = await github.isCollaborator(repository.owner.login, repository.name, username, token)
          if (isCollaborator) {
            debug(`${fullName}: ${username} is collaborator`)
            return Promise.resolve(comment)
          }
        }
        // and orgs
        if (orgs) {
          const orgMember = await Promise.all(orgs.map(o => github.isMemberOfOrg(o, username, token)))
          if (orgMember.indexOf(true) >= 0) {
            debug(`${fullName}: ${username} is org member`)
            return Promise.resolve(comment)
          }
        }
        debug(`${fullName}: ${username}'s approval does not count`)
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
   *   3. set status to ok when there are enough approvals
   * - IssueComment create/delete:
   *   1. verify it's on an open pull request
   *   2. set status to pending for open PR
   *   3. count approvals since last commit
   *   4. set status to ok when there are enough approvals
   * - PR synchronize (new commits on top):
   *   1. set status back to pending (b/c there can't be comments afterwards already)
   */

  static async execute(github, config, hookPayload, token, dbRepoId, pullRequestHandler) {
    const {action, repository, pull_request, number, issue} = hookPayload
    const repo = repository.name
    const user = repository.owner.login
    const {minimum} = config.approvals
    let sha = ''
    const pendingPayload = {
      state: 'pending',
      description: 'Approval validation in progress.',
      context
    }
    debug(`${repository.full_name}: Got hook`)
    try {
      // on an open pull request
      if (!!pull_request && pull_request.state === 'open') {
        // if it was (re)opened
        if (action === 'opened' || action === 'reopened') {
          // set status to pending first
          sha = pull_request.head.sha
          await github.setCommitStatus(user, repo, pull_request.head.sha, pendingPayload, token)
          // check if we have PR already and create if we don't
          let dbPR = await pullRequestHandler.onGet(dbRepoId, number)
          if (!dbPR) {
            dbPR = await pullRequestHandler.onCreatePullRequest(dbRepoId, number)
          }
          if (action === 'opened' && minimum > 0) {
            // if it was opened, set to pending
            await github.setCommitStatus(user, repo, pull_request.head.sha, {
              state: 'pending',
              description: this.generateStatusMessage(0, minimum),
              context
            }, token)
            info(`${repository.full_name}#${number}: PR was opened, set state to pending`)
            return
          }
          // get approvals for pr
          const opener = pull_request.user.login
          const comments = await github.getComments(user, repo, number, formatDate(dbPR.last_push), token)
          const countConfig = Object.assign({}, config.approvals, {ignore: [opener]})
          const approvals = await this.countApprovals(github, repository, comments, countConfig, token)
          const state = approvals < minimum ? 'pending' : 'success'
          let status = {
            state,
            context,
            description: this.generateStatusMessage(approvals, minimum)
          }
          // update status
          await github.setCommitStatus(user, repo, pull_request.head.sha, status, token)
          info(`${repository.full_name}#${number}: PR was reopened, set state to ${state} (${approvals}/${minimum})`)
        // if it was synced, ie a commit added to it
        } else if (action === 'synchronize') {
          // update last push in db
          await pullRequestHandler.onAddCommit(dbRepoId, number)
          // set status to pending (has to be unlocked with further comments)
          await github.setCommitStatus(user, repo, pull_request.head.sha, {
            state: 'pending',
            description: this.generateStatusMessage(0, minimum),
            context
          }, token)
          info(`${repository.full_name}#${number}: PR was synced, set state to pending`)
        }
      // on an issue comment
      } else if (!!issue) {
        // check it belongs to an open pr
        const pr = await github.getPullRequest(user, repo, issue.number, token)
        if (!pr || pr.state !== 'open') {
          debug(`${repository.full_name}#${issue.number}: Ignoring comment, not a PR`)
          return
        }
        sha = pr.head.sha
        // set status to pending first
        await github.setCommitStatus(user, repo, pr.head.sha, pendingPayload, token)
        // read last push date from db
        let dbPR = await pullRequestHandler.onGet(dbRepoId, issue.number)
        if (!dbPR) {
          dbPR = await pullRequestHandler.onCreatePullRequest(dbRepoId, issue.number)
        }
        // get approval count
        const opener = pr.user.login
        const countConfig = Object.assign({}, config.approvals, {ignore: [opener]})
        const comments = await github.getComments(user, repo, issue.number, formatDate(dbPR.last_push), token)
        const approvals = await this.countApprovals(github, repository, comments, countConfig, token)
        const state = approvals < minimum ? 'pending' : 'success'
        let status = {
          state,
          context,
          description: this.generateStatusMessage(approvals, minimum)
        }
        // update status
        await github.setCommitStatus(user, repo, pr.head.sha, status, token)
        info(`${repository.full_name}#${issue.number}: Comment added, set state to ${state} (${approvals}/${minimum})`)
      }
    }
    catch(e) {
      error(e)
      await github.setCommitStatus(user, repo, sha, {
        state: 'error',
        context,
        description: e.message
      }, token)

    }
  }
}
