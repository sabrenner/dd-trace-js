'use strict'

const os = require('os')
const path = require('path')
const uuid = require('crypto-randomuuid')
const requirePackageJson = require('../require-package-json')
const { getContext } = require('../gateway/engine')
const Addresses = require('./addresses')
const Scheduler = require('../exporters/agent/scheduler')
const request = require('../exporters/agent/request')
const log = require('../log')

const FLUSH_INTERVAL = 2e3
const MAX_EVENT_BACKLOG = 1e6

const REQUEST_HEADERS_WHITELIST = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'forwarded',
  'forwarded-for',
  'host',
  'true-client-ip',
  'user-agent',
  'via',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded',
  'x-forwarded-for',
  'x-real-ip'
]

const host = {
  context_version: '0.1.0',
  os_type: os.type(),
  hostname: os.hostname()
}

const library = {
  context_version: '0.1.0',
  runtime_type: 'nodejs',
  runtime_version: process.version,
  lib_version: requirePackageJson(path.join(__dirname, '..', '..', '..', '..')).version
}

const events = new Set()

function resolveHTTPRequest (context) {
  if (!context) return {}

  const path = context.resolve(Addresses.HTTP_INCOMING_URL)
  const headers = context.resolve(Addresses.HTTP_INCOMING_HEADERS)

  // TODO: should we really hardcode the url like that ?
  const url = new URL(path, `http://${headers.host}`)

  return {
    method: context.resolve(Addresses.HTTP_INCOMING_METHOD),
    url: url.href.split('?')[0],
    // resource: context.resolve(Addresses.HTTP_INCOMING_ROUTE),
    remote_ip: context.resolve(Addresses.HTTP_INCOMING_REMOTE_IP),
    remote_port: context.resolve(Addresses.HTTP_INCOMING_REMOTE_PORT),
    headers: filterHeaders(headers, REQUEST_HEADERS_WHITELIST)
  }
}

function filterHeaders (headers, whitelist) {
  const result = {}

  if (!headers) return result

  for (let i = 0; i < whitelist.length; ++i) {
    const headerName = whitelist[i]

    if (headers[headerName]) {
      result[headerName] = [ headers[headerName] ]
    }
  }

  return result
}

function getTracerData () {
  const tracer = global._ddtrace._tracer

  const result = {
    serviceName: tracer._service,
    serviceEnv: tracer._env,
    serviceVersion: tracer._version,
    tags: Object.entries(tracer._tags).map(([k, v]) => `${k}:${v}`)
  }

  const activeSpan = tracer.scope().active()

  if (activeSpan) {
    // TODO: this could be optimized to run only once per request
    activeSpan.setTag('manual.keep')
    activeSpan.setTag('appsec.event', true)

    const context = activeSpan.context()

    result.spanId = context.toSpanId()
    result.traceId = context.toTraceId()
  }

  return result
}

function reportAttack (rule, ruleMatch) {
  if (events.size > MAX_EVENT_BACKLOG) return

  const context = getContext()

  const resolvedRequest = resolveHTTPRequest(context)

  const tracerData = getTracerData()

  // TODO: check if some contextes could be empty
  const event = {
    event_id: uuid(),
    event_type: 'appsec',
    event_version: '1.0.0',
    detected_at: (new Date()).toJSON(),
    rule,
    rule_match: ruleMatch,
    context: {
      host,
      http: {
        context_version: '1.0.0',
        request: resolvedRequest
      },
      library,
      service: {
        context_version: '0.1.0',
        name: tracerData.serviceName,
        environment: tracerData.serviceEnv,
        version: tracerData.serviceVersion
      },
      span: {
        context_version: '0.1.0',
        id: tracerData.spanId
      },
      tags: {
        context_version: '0.1.0',
        values: tracerData.tags
      },
      trace: {
        context_version: '0.1.0',
        id: tracerData.traceId
      }
    }
  }

  events.add(event)

  return event
}

let lock = false

function flush () {
  if (lock || !events.size) return false

  if (events.size >= MAX_EVENT_BACKLOG) {
    log.warn('Dropping AppSec events because the backlog is full')
  }

  const eventsArray = Array.from(events)

  // if they fail to send, we drop the events
  for (let i = 0; i < eventsArray.length; ++i) {
    events.delete(eventsArray[i])
  }

  const options = {
    path: '/appsec/proxy/api/v2/appsecevts',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      protocol_version: 1,
      idempotency_key: uuid(),
      events: eventsArray
    })
  }

  const url = global._ddtrace._tracer._exporter._writer._url

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  lock = true

  return request(options, (err, res, status) => {
    lock = false

    if (err) {
      log.error(err)
    }
  })
}

const scheduler = new Scheduler(flush, FLUSH_INTERVAL)

module.exports = {
  events,
  resolveHTTPRequest,
  filterHeaders,
  getTracerData,
  reportAttack,
  flush,
  scheduler
}
