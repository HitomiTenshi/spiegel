'use strict'

const sporks = require('sporks')
const Process = require('./process')
const ChangeProcessor = require('./change-processor')
const utils = require('./utils')
const { DatabaseNotFoundError, ApiRequestError } = require('./errors')
const { Backoff } = require('./backoff')

class ChangeListeners extends Process {
  constructor(spiegel, opts) {
    super(
      spiegel,
      {
        passwords: utils.getOpt(opts, 'passwords'),
        retryAfterSeconds: utils.getOpt(opts, 'retryAfterSeconds'),
        concurrency: utils.getOpt(opts, 'concurrency'),
        checkStalledSeconds: utils.getOpt(opts, 'checkStalledSeconds'),
        assumeDeletedAfterSeconds: utils.getOpt(opts, 'assumeDeletedAfterSeconds')
      },
      'change_listener'
    )

    // The max number of changes that will be processed in a batch
    this._batchSize = utils.getOpt(opts, 'batchSize', 100)

    // Separate namespace for change listener ids
    this._idPrefix = 'spiegel_cl_'

    this._changeProcessor = new ChangeProcessor(spiegel, opts)

    // Backoff policy allows us to retry failed API requests for change listeners with delays in
    // between requests, preventing unwanted consumption of server resources.
    this._backoff = new Backoff(
      // The type of backoff policy. Either "exponential" or "linear".
      utils.getOpt(opts, 'backoffStrategy', 'linear'),
      // The type of backoff policy. Either "exponential" or "linear".
      parseFloat(utils.getOpt(opts, 'backoffMultiplier', 2)),
      // The interval between retries if type=linear or the initial interval if type=exponential.
      parseInt(utils.getOpt(opts, 'backoffDelay', 5)),
      // The maximum number of retries to make.
      parseInt(utils.getOpt(opts, 'backoffLimit', 0))
    )
  }

  _createListenersByDBNameView() {
    var doc = {
      _id: '_design/change_listeners_by_db_name',
      views: {
        change_listeners_by_db_name: {
          map: [
            'function(doc) {',
            'if (doc.type === "change_listener") {',
            'emit(doc.db_name, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    }

    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, doc)
  }

  async _createViews() {
    await super._createViews()
    await this._createListenersByDBNameView()
  }

  async _destroyViews() {
    await super._destroyViews()
    await this._slouch.doc.getAndDestroy(
      this._spiegel._dbName,
      '_design/change_listeners_by_db_name'
    )
  }

  install() {
    return this._createViews()
  }

  uninstall() {
    return this._destroyViews()
  }

  // Prefix so that we can create a listener even when the id is reserved, e.g. _users
  _toId(dbName) {
    return this._idPrefix + dbName
  }

  // _getByDBName (dbName) {
  //   return this._slouch.doc.getIgnoreMissing(this._spiegel._dbName, this._toId(dbName))
  // }

  _updateLastSeq(id, lastSeq) {
    // Use getMergeUpsert as we want the lastSeq to be stored even if there is a conflict from say
    // another process dirtying this ChangeListener
    return this._slouch.doc.getMergeUpsert(
      this._spiegel._dbName,
      { _id: id, last_seq: lastSeq }
    )
  }

  async _getByDBNames(dbNames) {
    let response = await this._slouch.db.viewArray(
      this._spiegel._dbName,
      '_design/change_listeners_by_db_name',
      'change_listeners_by_db_name',
      { include_docs: true, keys: JSON.stringify(dbNames) }
    )

    return response.rows.map(row => row.doc)
  }

  async _getCleanLockedOrMissing(dbNames) {
    let listeners = await this._getByDBNames(dbNames)

    // Index by dbName for quick retrieval
    let missing = sporks.flip(dbNames)

    let lists = []
    listeners.map(listener => {
      // Remove from missing
      delete missing[listener.db_name]

      // Clean or locked?
      if (!listener.dirty || listener.locked_at) {
        lists.push(listener)
      }
    })

    sporks.each(missing, (val, dbName) => {
      lists.push({
        db_name: dbName
      })
    })

    return lists
  }

  _create(listener) {
    listener._id = this._toId(listener.db_name)
    listener.type = 'change_listener'
    this._setUpdatedAt(listener)
    return this._slouch.doc.create(this._spiegel._dbName, listener)
  }

  _dirtyOrCreate(listeners) {
    listeners.forEach(listener => {
      // Existing listener?
      if (listener._id) {
        listener.dirty = true
        this._setUpdatedAt(listener)
      } else {
        listener._id = this._toId(listener.db_name)
        listener.type = 'change_listener'
        listener.dirty = true
        this._setUpdatedAt(listener)
      }
    })

    return this._slouch.doc.bulkCreateOrUpdate(this._spiegel._dbName, listeners)
  }

  async _dirtyAndGetConflictedDBNames(listeners) {
    let response = await this._dirtyOrCreate(listeners)

    // Get a list of all the dbNames where we have conflicts. This can occur because the listener
    // was dirtied, locked or otherwise updated between the _getByDBNames() and _dirtyOrCreate()
    // calls. We use an object instead of an array as we want to make sure that we only have a
    // single entry per db or else we can end up with an infinitely growing list due to the
    // recursion.
    var conflictedDBNames = {}
    response.forEach((doc, i) => {
      if (this._slouch.doc.isConflictError(doc)) {
        conflictedDBNames[listeners[i].db_name] = true
      }
    })

    return Object.keys(conflictedDBNames)
  }

  async _attemptToDirtyIfCleanOrLocked(dbNames) {
    let listeners = await this._getCleanLockedOrMissing(dbNames)

    // length can be zero if there is nothing to dirty
    if (listeners.length > 0) {
      return this._dirtyAndGetConflictedDBNames(listeners)
    }
  }

  // We need to dirty ChangeListeners so that the listening can be delegated to a listener process.
  //
  // We use bulk operations as this is far faster than processing each ChangeListener individually.
  // With bulk operations we can take a batch of updates and in just a few requests to CouchDB
  // schedule the delegation and then move on to the next set of updates. In addition, processing
  // updates in a batch allows us to remove duplicates in that batch that often occur due to
  // back-to-back writes to a particular DB.
  //
  // When dirtying the ChangeListener we first get a list of all the ChangeListeners with matching
  // DB names. We then iterate through the results identifying clean or locked ChangeListeners and
  // any missing ChangeListeners. We need to include the locked ChangeListeners as we may already be
  // listening to a _changes feed, hence the lock, and we want to make sure to re-dirty the listener
  // so that the revision number changes. This will then result in the listener being retried later.
  // ChangeListeners are created when they are missing. A ChangeListeners's id is unique to the DB
  // name and this therefore prevents two UpdateListener processes from creating duplicate
  // ChangeListeners.
  //
  // Between the time the clean or locked ChangeListeners are retrieved and then dirtied, it is
  // possible that another UpdateListener dirties the same ChangeListener. In this event, we'll
  // detect the conflicts. We'll then retry the get and dirty for these conflicted ChangeListeners.
  // We'll repeat this process until there are no more conflicts.
  async dirtyIfCleanOrLocked(dbNames) {
    let conflictedDBNames = await this._attemptToDirtyIfCleanOrLocked(dbNames)
    if (conflictedDBNames && conflictedDBNames.length > 0) {
      return this.dirtyIfCleanOrLocked(conflictedDBNames)
    }
  }

  _processChange(change, dbName, requests) {
    return this._changeProcessor.process(change, dbName, requests)
  }

  _processChangeFactory(change, dbName, requests) {
    return () => {
      return this._processChange(change, dbName, requests)
    }
  }

  _slouchChangesArray(dbName, opts) {
    return this._slouch.db.changesArray(dbName, opts)
  }

  _changesArray(dbName, opts) {
    return this._slouchChangesArray(dbName, opts)
  }

  _changesForListener(listener) {
    return this._changesArray(listener.db_name, {
      since: listener.last_seq || undefined,
      include_docs: true,
      limit: this._batchSize
    }).catch(err => {
      if (err.error === 'not_found') {
        err = new DatabaseNotFoundError(listener.db_name)
      }
      throw err
    })
  }

  async _scheduleRetry(item) {
    const retries = item.retries ? item.retries : 0

    if (this._backoff.hasReachedRetryLimit(retries) === true) {
      this._clearRetries(item)
      return
    }

    let dirtyTime = new Date(
      new Date().getTime() + this._backoff.getDelaySecs(retries) * 1000
    ).toISOString()

    this._setDirtyAt(item, dirtyTime)

    item.retries = retries + 1

    await this._updateItem(item, true)
    this._queueSoiler(dirtyTime)
  }

  async _waitForRequests(requests, listener) {
    await Promise
      .all(requests)
      .catch(async(err) => {
        await this._onError(err)
        if (err instanceof ApiRequestError) {
          // If a request fails, we dirty the listener and leave the last sequence
          // untouched so that the change is processed again. The listener is set
          // to be dirtied at some point in the future based on the global command
          // params for backoff.
          await this._scheduleRetry(listener)
        } else {
          throw err
        }
      })
  }

  async _processChanges(listener, changes) {
    let chain = Promise.resolve()

    // Array of promises used to ensure that all requests have completed before moving on to the
    // next batch
    let requests = []

    // Sequentially chain promises so that changes are processed in order and so that we don't
    // dominate the mem
    changes.results.forEach(change => {
      chain = chain.then(this._processChangeFactory(change, listener.db_name, requests))
    })

    // Wait for all the changes to be processed
    await chain

    // Wait for all API requests to complete
    await this._waitForRequests(requests, listener)
  }

  _moreBatches(changes) {
    return !!changes.pending
  }

  async _processBatchOfChanges(listener) {
    let changes = await this._changesForListener(listener)

    await this._processChanges(listener, changes)

    // Save the lastSeq as we want our next batch to resume from where we left off
    if (!!listener.dirty_at === false) {
      await this._updateLastSeq(listener._id, changes.last_seq)
    }

    // Are there more batches to process? If there are then we will leave this ChangeListener
    // dirty
    return this._moreBatches(changes)
  }

  async _processBatchOfChangesLogError(listener) {
    try {
      await this._processBatchOfChanges(listener)
    } catch (err) {
      if (err instanceof DatabaseNotFoundError) {
        throw err
      }
      // Log and emit error
      await this._onError(err)

      // Leave the ChangeListener as dirty so that it will be retried
      return true
    }
  }

  _process(listener) {
    if (listener.db_name) {
      listener.db_name = decodeURIComponent(listener.db_name);
    }

    return this._processBatchOfChangesLogError(listener)
  }
}

module.exports = ChangeListeners
