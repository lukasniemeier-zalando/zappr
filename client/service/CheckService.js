import fetch from 'isomorphic-fetch'

import Service from './Service'
import { logger } from '../../common/debug'

const log = logger('CheckService')

class CheckError extends Error {
  constructor(check, message) {
    super(message)
    this.repoId = check.repoId
    this.type = check.type
  }
}

export default class RepoService extends Service {

  static enableCheck(check) {
    log('enable check %o', check)
    return fetch(Service.url(`/api/repos/${check.repoId}/${check.type}`), {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      credentials: 'same-origin'
    }).then(response => {
      // Merge the argument with the server response so that we don't lose
      // important client-only attributes (e.g. isUpdating, etc.)
      if (response.ok) return response.json().then(json => ({...check, ...json}))
      else throw new CheckError(check, response.statusText)
    })
  }

  static disableCheck(check) {
    log('disable check %o', check)
    return fetch(Service.url(`/api/repos/${check.repoId}/${check.type}`), {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      credentials: 'same-origin'
    }).then(response => {
      if (!response.ok) throw new CheckError(check, response.statusText)
    })
  }
}
