'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindEventEmitter,
  bindEmit
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
// const storage = require('../../datadog-core').storage
const { storage } = require('../../datadog-core')
// const tracer =  require('../../dd-trace')

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.5'] }, Bucket => {
  const startChn1qlReq = channel('apm:couchbase:_n1qlReq:start')
  const asyncEndChn1qlReq = channel('apm:couchbase:_n1qlReq:async-end')
  const endChn1qlReq = channel('apm:couchbase:_n1qlReq:end')
  const errorChn1qlReq = channel('apm:couchbase:_n1qlReq:error')
  debugger;
  
  // console.log(0, storage.getStore())
  bindEventEmitter(Bucket.prototype)
  bindEventEmitter(Bucket.N1qlQueryResponse.prototype)
  // console.log(0, tracer.scope().active())
  // bindEmit(Bucket.prototype, errorChn1qlReq, asyncEndChn1qlReq)
  // bindEmit(Bucket.N1qlQueryResponse.prototype, errorChn1qlReq, asyncEndChn1qlReq)

  Bucket.prototype._maybeInvoke = wrapMaybeInvoke(Bucket.prototype._maybeInvoke)
  Bucket.prototype.query = wrapQuery(Bucket.prototype.query)

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChn1qlReq.hasSubscribers
    ) {
      return _n1qlReq.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = q && q.statement

    startChn1qlReq.publish([n1qlQuery, this])

    emitter.once('rows', bind(() => {
      debugger;
      asyncEndChn1qlReq.publish(undefined)
    }))

    emitter.once('error', bind((error) => {
      debugger;
      errorChn1qlReq.publish(error)
      asyncEndChn1qlReq.publish(undefined)
    }))

    try {
      return ar.runInAsyncScope(() => {
        return _n1qlReq.apply(this, arguments)
      })
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorChn1qlReq.publish(err)

      throw err
    } finally {
      endChn1qlReq.publish(undefined)
    }
  })

  Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert)
  Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert)
  Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace)
  Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append)
  Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend)

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.5'] }, Cluster => {
  debugger;
  Cluster.prototype._maybeInvoke = wrapMaybeInvoke(Cluster.prototype._maybeInvoke)
  Cluster.prototype.query = wrapQuery(Cluster.prototype.query)
  return Cluster
})

function findCallbackIndex (args) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
}

function wrapMaybeInvoke (_maybeInvoke) {
  const wrapped = function (fn, args) {
    debugger;
    
    const ar = new AsyncResource('bound-anonymous-fn')
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return _maybeInvoke.apply(this, arguments)
    })
  }
  return shimmer.wrap(_maybeInvoke, wrapped)
}

function wrapQuery (query) {
  const wrapped = function (q, params, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return query.apply(this, arguments)
    })
  }
  return shimmer.wrap(query, wrapped)
}

function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  const wrapped = function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startCh.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const cb = arguments[callbackIndex]

    startCh.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      return ar.runInAsyncScope(() => {
        return fn.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorCh.publish(error)

      throw error
    } finally {
      endCh.publish(undefined)
    }
  }
  return shimmer.wrap(fn, wrapped)
}
