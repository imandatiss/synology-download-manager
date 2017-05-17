import Axios from 'axios';
import { StatefulApi, ConnectionFailure, isConnectionFailure, errorMessageFromCode, DownloadStation, SynologyResponse } from './api';
import { CachedTasks } from './state';
import { notify } from './browserApi';

export function clearCachedTasks() {
  const emptyState: CachedTasks = {
    tasks: [],
    taskFetchFailureReason: null,
    tasksLastCompletedFetchTimestamp: null,
    tasksLastInitiatedFetchTimestamp: null
  };

  return browser.storage.local.set(emptyState);
}

export function pollTasks(api: StatefulApi) {
  const cachedTasks: Partial<CachedTasks> = {
    tasksLastInitiatedFetchTimestamp: Date.now()
  };

  console.log('polling for tasks...');

  return Promise.all([
    browser.storage.local.set(cachedTasks),
    api.DownloadStation.Task.List({
      offset: 0,
      limit: -1,
      additional: [ 'transfer' ]
    })
  ])
    .then(([ _, response ]) => {
      const cachedTasks: Partial<CachedTasks> = {
        tasksLastCompletedFetchTimestamp: Date.now()
      };

      if (isConnectionFailure(response)) {
        if (response.type === 'missing-config') {
          cachedTasks.taskFetchFailureReason = 'missing-config';
        } else {
          cachedTasks.taskFetchFailureReason = { failureMessage: response.failureMessage };
        }
      } else if (response.success) {
        cachedTasks.tasks = response.data.tasks;
        cachedTasks.taskFetchFailureReason = null;
      } else {
        cachedTasks.taskFetchFailureReason = {
          failureMessage: errorMessageFromCode(response.error.code, DownloadStation.Task.API_NAME)
        };
      }

      return browser.storage.local.set(cachedTasks);
    })
    .catch(error => {
      let failureMessage;
      // TODO: Unify this knowledge with utils.ts and settings.tsx.
      if (error && error.response && error.response.status === 400) {
        failureMessage = 'Connection failure (likely wrong protocol).';
      } else if (error && error.message === 'Network Error') {
        failureMessage = 'Connection failure (likely incorrect hostname/port or no internet connection).';
      } else {
        console.log(error);
        failureMessage = 'Unknown error.';
      }

      const cachedTasks: Partial<CachedTasks> = {
        taskFetchFailureReason: { failureMessage },
        tasksLastCompletedFetchTimestamp: Date.now()
      };

      return browser.storage.local.set(cachedTasks);
    });
}

const AUTO_DOWNLOAD_TORRENT_FILE_PROTOCOLS = [
  'http',
  'https',
  'ftp',
  'ftps'
];

const DOWNLOADABLE_PROTOCOLS = [
  'http',
  'https',
  'ftp',
  'ftps',
  'magnet'
];

const ARBITRARY_FILE_FETCH_SIZE_CUTOFF = 1024 * 1024 * 5;

function startsWithAnyProtocol(url: string, protocols: string[]) {
  return protocols.some(protocol => url.startsWith(`${protocol}://`));
}

export function addDownloadTask(api: StatefulApi, url: string) {
  const notificationId = notify('Adding download...', url);

  function notifyTaskAddResult(result: ConnectionFailure | SynologyResponse<{}>) {
    if (isConnectionFailure(result)) {
      notify('Failed to connection to DiskStation', 'Please check your settings.', notificationId);
    } else if (result.success) {
      notify('Download added', url, notificationId);
    } else {
      notify('Failed to add download', errorMessageFromCode(result.error.code, DownloadStation.Task.API_NAME), notificationId);
    }
  }

  if (url) {
    if (startsWithAnyProtocol(url, AUTO_DOWNLOAD_TORRENT_FILE_PROTOCOLS)) {
      return Axios.head(url, { timeout: 10000 })
        .then(response => {
          const contentType = response.headers['content-type'].toLowerCase();
          const contentLength = response.headers['content-length'];
          // TODO: Should strip query parameters from this URL before checking the extension.
          if (((contentType === 'application/x-bittorrent') || url.endsWith('.torrent')) && !isNaN(contentLength) && contentLength < ARBITRARY_FILE_FETCH_SIZE_CUTOFF) {
            return Axios.get(url, { responseType: 'arraybuffer' })
              .then(response => {
                const blob = new Blob([ response.data ], { type: 'application/x-bittorrent' });
                return api.DownloadStation.Task.Create({ file: { content: blob, filename: 'download.torrent' } });
              });
          } else {
            return api.DownloadStation.Task.Create({
              uri: [ url ]
            });
          }
        })
        .then(notifyTaskAddResult);
    } else if (startsWithAnyProtocol(url, DOWNLOADABLE_PROTOCOLS)) {
      return api.DownloadStation.Task.Create({
        uri: [ url ]
      })
        .then(notifyTaskAddResult);
    } else {
      notify('Failed to add download', `URL must start with one of ${DOWNLOADABLE_PROTOCOLS.join(', ')}`);
      return Promise.resolve();
    }
  } else {
    notify('Failed to add download', 'No URL to download given');
    return Promise.resolve();
  }
}