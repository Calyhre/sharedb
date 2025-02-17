var hat = require('hat');
var types = require('./types');
var util = require('./util');
var logger = require('./logger');

/**
 * Agent deserializes the wire protocol messages received from the stream and
 * calls the corresponding functions on its Agent. It uses the return values
 * to send responses back. Agent also handles piping the operation streams
 * provided by a Agent.
 *
 * @param {Backend} backend
 * @param {Duplex} stream connection to a client
 */
function Agent(backend, stream) {
  this.backend = backend;
  this.stream = stream;

  this.clientId = hat();
  this.connectTime = Date.now();

  // We need to track which documents are subscribed by the client. This is a
  // map of collection -> id -> stream
  this.subscribedDocs = {};

  // Map from queryId -> emitter
  this.subscribedQueries = {};

  // We need to track this manually to make sure we don't reply to messages
  // after the stream was closed.
  this.closed = false;

  // For custom use in middleware. The agent is a convenient place to cache
  // session state in memory. It is in memory only as long as the session is
  // active, and it is passed to each middleware call
  this.custom = {};

  // Initialize the remote client by sending it its agent Id.
  this.send({
    a: 'init',
    protocol: 1,
    id: this.clientId,
    type: types.defaultType.uri
  });
}
module.exports = Agent;

// Close the agent with the client.
Agent.prototype.close = function(err) {
  if (err) {
    logger.warn('Agent closed due to error', this.clientId, err.stack || err);
  }
  if (this.closed) return;
  // This will end the writable stream and emit 'finish'
  this.stream.end();
};

Agent.prototype._cleanup = function() {
  // Only clean up once if the stream emits both 'end' and 'close'.
  if (this.closed) return;

  this.closed = true;

  this.backend.agentsCount--;
  if (!this.stream.isServer) this.backend.remoteAgentsCount--;

  // Clean up doc subscription streams
  for (var collection in this.subscribedDocs) {
    var docs = this.subscribedDocs[collection];
    for (var id in docs) {
      var stream = docs[id];
      stream.destroy();
    }
  }
  this.subscribedDocs = {};

  // Clean up query subscription streams
  for (var id in this.subscribedQueries) {
    var emitter = this.subscribedQueries[id];
    emitter.destroy();
  }
  this.subscribedQueries = {};
};

/**
 * Passes operation data received on stream to the agent stream via
 * _sendOp()
 */
Agent.prototype._subscribeToStream = function(collection, id, stream) {
  if (this.closed) return stream.destroy();

  var streams = this.subscribedDocs[collection] || (this.subscribedDocs[collection] = {});

  // If already subscribed to this document, destroy the previously subscribed stream
  var previous = streams[id];
  if (previous) previous.destroy();
  streams[id] = stream;

  var agent = this;
  stream.on('data', function(data) {
    if (data.error) {
      // Log then silently ignore errors in a subscription stream, since these
      // may not be the client's fault, and they were not the result of a
      // direct request by the client
      logger.error('Doc subscription stream error', collection, id, data.error);
      return;
    }
    agent._onOp(collection, id, data);
  });
  stream.on('end', function() {
    // The op stream is done sending, so release its reference
    var streams = agent.subscribedDocs[collection];
    if (!streams || streams[id] !== stream) return;
    delete streams[id];
    if (util.hasKeys(streams)) return;
    delete agent.subscribedDocs[collection];
  });
};

Agent.prototype._subscribeToQuery = function(emitter, queryId, collection, query) {
  var previous = this.subscribedQueries[queryId];
  if (previous) previous.destroy();
  this.subscribedQueries[queryId] = emitter;

  var agent = this;
  emitter.onExtra = function(extra) {
    agent.send({a: 'q', id: queryId, extra: extra});
  };

  emitter.onDiff = function(diff) {
    for (var i = 0; i < diff.length; i++) {
      var item = diff[i];
      if (item.type === 'insert') {
        item.values = getResultsData(item.values);
      }
    }
    // Consider stripping the collection out of the data we send here
    // if it matches the query's collection.
    agent.send({a: 'q', id: queryId, diff: diff});
  };

  emitter.onError = function(err) {
    // Log then silently ignore errors in a subscription stream, since these
    // may not be the client's fault, and they were not the result of a
    // direct request by the client
    logger.error('Query subscription stream error', collection, query, err);
  };

  emitter.onOp = function(op) {
    var id = op.d;
    agent._onOp(collection, id, op);
  };

  emitter._open();
};

Agent.prototype._onOp = function(collection, id, op) {
  if (this._isOwnOp(collection, op)) return;

  // Ops emitted here are coming directly from pubsub, which emits the same op
  // object to listeners without making a copy. The pattern in middleware is to
  // manipulate the passed in object, and projections are implemented the same
  // way currently.
  //
  // Deep copying the op would be safest, but deep copies are very expensive,
  // especially over arbitrary objects. This function makes a shallow copy of an
  // op, and it requires that projections and any user middleware copy deep
  // properties as needed when they modify the op.
  //
  // Polling of query subscriptions is determined by the same op objects. As a
  // precaution against op middleware breaking query subscriptions, we delay
  // before calling into projection and middleware code
  var agent = this;
  process.nextTick(function() {
    var copy = shallowCopy(op);
    agent.backend.sanitizeOp(agent, collection, id, copy, function(err) {
      if (err) {
        logger.error('Error sanitizing op emitted from subscription', collection, id, copy, err);
        return;
      }
      agent._sendOp(collection, id, copy);
    });
  });
};

Agent.prototype._isOwnOp = function(collection, op) {
  // Detect ops from this client on the same projection. Since the client sent
  // these in, the submit reply will be sufficient and we can silently ignore
  // them in the streams for subscribed documents or queries
  return (this.clientId === op.src) && (collection === (op.i || op.c));
};

Agent.prototype.send = function(message) {
  // Quietly drop replies if the stream was closed
  if (this.closed) return;

  this.backend.emit('send', this, message);
  this.stream.write(message);
};

Agent.prototype._sendOp = function(collection, id, op) {
  var message = {
    a: 'op',
    c: collection,
    d: id,
    v: op.v,
    src: op.src,
    seq: op.seq
  };
  if (op.op) message.op = op.op;
  if (op.create) message.create = op.create;
  if (op.del) message.del = true;

  this.send(message);
};
Agent.prototype._sendOps = function(collection, id, ops) {
  for (var i = 0; i < ops.length; i++) {
    this._sendOp(collection, id, ops[i]);
  }
};
Agent.prototype._sendOpsBulk = function(collection, opsMap) {
  for (var id in opsMap) {
    var ops = opsMap[id];
    this._sendOps(collection, id, ops);
  }
};

function getReplyErrorObject(err) {
  if (typeof err === 'string') {
    return {
      code: 4001,
      message: err
    };
  } else {
    if (err.stack) {
      logger.info(err.stack);
    }
    return {
      code: err.code,
      message: err.message
    };
  }
}

Agent.prototype._reply = function(request, err, message) {
  var agent = this;
  var backend = agent.backend;
  if (err) {
    request.error = getReplyErrorObject(err);
    agent.send(request);
    return;
  }
  if (!message) message = {};

  message.a = request.a;
  if (request.id) {
    message.id = request.id;
  } else {
    if (request.c) message.c = request.c;
    if (request.d) message.d = request.d;
    if (request.b && !message.data) message.b = request.b;
  }

  var middlewareContext = {request: request, reply: message};
  backend.trigger(backend.MIDDLEWARE_ACTIONS.reply, agent, middlewareContext, function(err) {
    if (err) {
      request.error = getReplyErrorObject(err);
      agent.send(request);
    } else {
      agent.send(middlewareContext.reply);
    }
  });
};

// Start processing events from the stream
Agent.prototype._open = function() {
  if (this.closed) return;
  this.backend.agentsCount++;
  if (!this.stream.isServer) this.backend.remoteAgentsCount++;

  var agent = this;
  this.stream.on('data', function(chunk) {
    if (agent.closed) return;

    if (typeof chunk !== 'object') {
      var err = {code: 4000, message: 'Received non-object message'};
      return agent.close(err);
    }

    var request = {data: chunk};
    agent.backend.trigger('receive', agent, request, function(err) {
      var callback = function(err, message) {
        agent._reply(request.data, err, message);
      };
      if (err) return callback(err);
      agent._handleMessage(request.data, callback);
    });
  });

  var cleanup = agent._cleanup.bind(agent);
  this.stream.on('end', cleanup);
  this.stream.on('close', cleanup);
};

// Check a request to see if its valid. Returns an error if there's a problem.
Agent.prototype._checkRequest = function(request) {
  if (request.a === 'qf' || request.a === 'qs' || request.a === 'qu') {
    // Query messages need an ID property.
    if (typeof request.id !== 'number') return 'Missing query ID';
  } else if (request.a === 'op' || request.a === 'f' || request.a === 's' || request.a === 'u') {
    // Doc-based request.
    if (request.c != null && typeof request.c !== 'string') return 'Invalid collection';
    if (request.d != null && typeof request.d !== 'string') return 'Invalid id';

    if (request.a === 'op') {
      if (request.v != null && (typeof request.v !== 'number' || request.v < 0)) return 'Invalid version';
    }
  } else if (request.a === 'bf' || request.a === 'bs' || request.a === 'bu') {
    // Bulk request
    if (request.c != null && typeof request.c !== 'string') return 'Invalid collection';
    if (typeof request.b !== 'object') return 'Invalid bulk subscribe data';
  }
};

// Handle an incoming message from the client
Agent.prototype._handleMessage = function(request, callback) {
  try {
    var errMessage = this._checkRequest(request);
    if (errMessage) return callback({code: 4000, message: errMessage});

    switch (request.a) {
      case 'qf':
        return this._queryFetch(request.id, request.c, request.q, getQueryOptions(request), callback);
      case 'qs':
        return this._querySubscribe(request.id, request.c, request.q, getQueryOptions(request), callback);
      case 'qu':
        return this._queryUnsubscribe(request.id, callback);
      case 'bf':
        return this._fetchBulk(request.c, request.b, callback);
      case 'bs':
        return this._subscribeBulk(request.c, request.b, callback);
      case 'bu':
        return this._unsubscribeBulk(request.c, request.b, callback);
      case 'f':
        return this._fetch(request.c, request.d, request.v, callback);
      case 's':
        return this._subscribe(request.c, request.d, request.v, callback);
      case 'u':
        return this._unsubscribe(request.c, request.d, callback);
      case 'op':
        // Normalize the properties submitted
        var op = createClientOp(request, this.clientId);
        if (!op) return callback({code: 4000, message: 'Invalid op message'});
        return this._submit(request.c, request.d, op, callback);
      case 'nf':
        return this._fetchSnapshot(request.c, request.d, request.v, callback);
      case 'nt':
        return this._fetchSnapshotByTimestamp(request.c, request.d, request.ts, callback);
      default:
        callback({code: 4000, message: 'Invalid or unknown message'});
    }
  } catch (err) {
    callback(err);
  }
};
function getQueryOptions(request) {
  var results = request.r;
  var ids;
  var fetch;
  var fetchOps;
  if (results) {
    ids = [];
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      var id = result[0];
      var version = result[1];
      ids.push(id);
      if (version == null) {
        if (fetch) {
          fetch.push(id);
        } else {
          fetch = [id];
        }
      } else {
        if (!fetchOps) fetchOps = {};
        fetchOps[id] = version;
      }
    }
  }
  var options = request.o || {};
  options.ids = ids;
  options.fetch = fetch;
  options.fetchOps = fetchOps;
  return options;
}

Agent.prototype._queryFetch = function(queryId, collection, query, options, callback) {
  // Fetch the results of a query once
  this.backend.queryFetch(this, collection, query, options, function(err, results, extra) {
    if (err) return callback(err);
    var message = {
      data: getResultsData(results),
      extra: extra
    };
    callback(null, message);
  });
};

Agent.prototype._querySubscribe = function(queryId, collection, query, options, callback) {
  // Subscribe to a query. The client is sent the query results and its
  // notified whenever there's a change
  var agent = this;
  var wait = 1;
  var message;
  function finish(err) {
    if (err) return callback(err);
    if (--wait) return;
    callback(null, message);
  }
  if (options.fetch) {
    wait++;
    this.backend.fetchBulk(this, collection, options.fetch, function(err, snapshotMap) {
      if (err) return finish(err);
      message = {data: getMapData(snapshotMap)};
      finish();
    });
  }
  if (options.fetchOps) {
    wait++;
    this._fetchBulkOps(collection, options.fetchOps, finish);
  }
  this.backend.querySubscribe(this, collection, query, options, function(err, emitter, results, extra) {
    if (err) return finish(err);
    if (this.closed) return emitter.destroy();

    agent._subscribeToQuery(emitter, queryId, collection, query);
    // No results are returned when ids are passed in as an option. Instead,
    // want to re-poll the entire query once we've established listeners to
    // emit any diff in results
    if (!results) {
      emitter.queryPoll(finish);
      return;
    }
    message = {
      data: getResultsData(results),
      extra: extra
    };
    finish();
  });
};

function getResultsData(results) {
  var items = [];
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var item = getSnapshotData(result);
    item.d = result.id;
    items.push(item);
  }
  return items;
}

function getMapData(snapshotMap) {
  var data = {};
  for (var id in snapshotMap) {
    data[id] = getSnapshotData(snapshotMap[id]);
  }
  return data;
}

function getSnapshotData(snapshot) {
  var data = {
    v: snapshot.v,
    data: snapshot.data
  };
  if (types.defaultType !== types.map[snapshot.type]) {
    data.type = snapshot.type;
  }
  return data;
}

Agent.prototype._queryUnsubscribe = function(queryId, callback) {
  var emitter = this.subscribedQueries[queryId];
  if (emitter) {
    emitter.destroy();
    delete this.subscribedQueries[queryId];
  }
  process.nextTick(callback);
};

Agent.prototype._fetch = function(collection, id, version, callback) {
  if (version == null) {
    // Fetch a snapshot
    this.backend.fetch(this, collection, id, function(err, snapshot) {
      if (err) return callback(err);
      callback(null, {data: getSnapshotData(snapshot)});
    });
  } else {
    // It says fetch on the tin, but if a version is specified the client
    // actually wants me to fetch some ops
    this._fetchOps(collection, id, version, callback);
  }
};

Agent.prototype._fetchOps = function(collection, id, version, callback) {
  var agent = this;
  this.backend.getOps(this, collection, id, version, null, function(err, ops) {
    if (err) return callback(err);
    agent._sendOps(collection, id, ops);
    callback();
  });
};

Agent.prototype._fetchBulk = function(collection, versions, callback) {
  if (Array.isArray(versions)) {
    this.backend.fetchBulk(this, collection, versions, function(err, snapshotMap) {
      if (err) return callback(err);
      callback(null, {data: getMapData(snapshotMap)});
    });
  } else {
    this._fetchBulkOps(collection, versions, callback);
  }
};

Agent.prototype._fetchBulkOps = function(collection, versions, callback) {
  var agent = this;
  this.backend.getOpsBulk(this, collection, versions, null, function(err, opsMap) {
    if (err) return callback(err);
    agent._sendOpsBulk(collection, opsMap);
    callback();
  });
};

Agent.prototype._subscribe = function(collection, id, version, callback) {
  // If the version is specified, catch the client up by sending all ops
  // since the specified version
  var agent = this;
  this.backend.subscribe(this, collection, id, version, function(err, stream, snapshot, ops) {
    if (err) return callback(err);
    // If we're subscribing from a known version, send any ops committed since
    // the requested version to bring the client's doc up to date
    if (ops) {
      agent._sendOps(collection, id, ops);
    }
    // In addition, ops may already be queued on the stream by pubsub.
    // Subscribe is called before the ops or snapshot are fetched, so it is
    // possible that some ops may be duplicates. Clients should ignore any
    // duplicate ops they may receive. This will flush ops already queued and
    // subscribe to ongoing ops from the stream
    agent._subscribeToStream(collection, id, stream);
    // Snapshot is returned only when subscribing from a null version.
    // Otherwise, ops will have been pushed into the stream
    if (snapshot) {
      callback(null, {data: getSnapshotData(snapshot)});
    } else {
      callback();
    }
  });
};

Agent.prototype._subscribeBulk = function(collection, versions, callback) {
  // See _subscribe() above. This function's logic should match but in bulk
  var agent = this;
  this.backend.subscribeBulk(this, collection, versions, function(err, streams, snapshotMap, opsMap) {
    if (err) return callback(err);
    if (opsMap) {
      agent._sendOpsBulk(collection, opsMap);
    }
    for (var id in streams) {
      agent._subscribeToStream(collection, id, streams[id]);
    }
    if (snapshotMap) {
      callback(null, {data: getMapData(snapshotMap)});
    } else {
      callback();
    }
  });
};

Agent.prototype._unsubscribe = function(collection, id, callback) {
  // Unsubscribe from the specified document. This cancels the active
  // stream or an inflight subscribing state
  var docs = this.subscribedDocs[collection];
  var stream = docs && docs[id];
  if (stream) stream.destroy();
  process.nextTick(callback);
};

Agent.prototype._unsubscribeBulk = function(collection, ids, callback) {
  var docs = this.subscribedDocs[collection];
  if (!docs) return process.nextTick(callback);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var stream = docs[id];
    if (stream) stream.destroy();
  }
  process.nextTick(callback);
};

Agent.prototype._submit = function(collection, id, op, callback) {
  var agent = this;
  this.backend.submit(this, collection, id, op, null, function(err, ops) {
    // Message to acknowledge the op was successfully submitted
    var ack = {src: op.src, seq: op.seq, v: op.v};
    if (err) {
      // Occassional 'Op already submitted' errors are expected to happen as
      // part of normal operation, since inflight ops need to be resent after
      // disconnect. In this case, ack the op so the client can proceed
      if (err.code === 4001) return callback(null, ack);
      return callback(err);
    }

    // Reply with any operations that the client is missing.
    agent._sendOps(collection, id, ops);
    callback(null, ack);
  });
};

Agent.prototype._fetchSnapshot = function(collection, id, version, callback) {
  this.backend.fetchSnapshot(this, collection, id, version, callback);
};

Agent.prototype._fetchSnapshotByTimestamp = function(collection, id, timestamp, callback) {
  this.backend.fetchSnapshotByTimestamp(this, collection, id, timestamp, callback);
};


function createClientOp(request, clientId) {
  // src can be provided if it is not the same as the current agent,
  // such as a resubmission after a reconnect, but it usually isn't needed
  var src = request.src || clientId;
  // c, d, and m arguments are intentionally undefined. These are set later
  return (request.op) ? new EditOp(src, request.seq, request.v, request.op) :
    (request.create) ? new CreateOp(src, request.seq, request.v, request.create) :
      (request.del) ? new DeleteOp(src, request.seq, request.v, request.del) :
        undefined;
}

function shallowCopy(object) {
  var out = {};
  for (var key in object) {
    out[key] = object[key];
  }
  return out;
}

function CreateOp(src, seq, v, create, c, d, m) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.create = create;
  this.c = c;
  this.d = d;
  this.m = m;
}
function EditOp(src, seq, v, op, c, d, m) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.op = op;
  this.c = c;
  this.d = d;
  this.m = m;
}
function DeleteOp(src, seq, v, del, c, d, m) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.del = del;
  this.c = c;
  this.d = d;
  this.m = m;
}
