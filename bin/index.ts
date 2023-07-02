#! /usr/bin/env node
import axios, { AxiosRequestConfig } from 'axios';
import * as cliProgress from 'cli-progress';
import { Option, program } from 'commander';
import { PathsOutput, fdir } from 'fdir';
import FormData from 'form-data';
import * as fs from 'fs';
import { stat } from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import * as si from 'systeminformation';
// GLOBAL
import chalk from 'chalk';
import * as mime from 'mime-types';
import moment from 'moment';
import pLimit from 'p-limit';
import pjson from '../package.json';

const log = console.log;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
let errorAssets: any[] = [];

const SUPPORTED_MIME = [
  // IMAGES
  'image/heif',
  'image/heic',
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/dng',
  'image/x-adobe-dng',
  'image/webp',
  'image/tiff',
  'image/nef',
  'image/x-nikon-nef',

  // VIDEO
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/3gpp',
];

program.name('immich').description('Immich command line interface').version(pjson.version);

program
  .command('upload')
  .description('Upload assets to an Immich instance')
  .usage('upload [options] <paths...>')
  .addOption(new Option('-k, --key <value>', 'API Key').env('IMMICH_API_KEY'))
  .addOption(
    new Option(
      '-s, --server <value>',
      'Immich server address (http://<your-ip>:2283/api or https://<your-domain>/api)',
    ).env('IMMICH_SERVER_ADDRESS'),
  )
  .addOption(new Option('-r, --recursive', 'Recursive').env('IMMICH_RECURSIVE').default(false))
  .addOption(new Option('-y, --yes', 'Assume yes on all interactive prompts').env('IMMICH_ASSUME_YES'))
  .addOption(new Option('-da, --delete', 'Delete local assets after upload').env('IMMICH_DELETE_ASSETS'))
  .addOption(
    new Option('-t, --threads <num>', 'Amount of concurrent upload threads (default=5)').env('IMMICH_UPLOAD_THREADS'),
  )
  .addOption(
    new Option('-al, --album [album]', 'Create albums for assets based on the parent folder or a given name').env(
      'IMMICH_CREATE_ALBUMS',
    ),
  )
  .addOption(
    new Option('-i, --import', 'Import instead of upload').env(
      'IMMICH_IMPORT',
    ).default(false)
  )
  .addOption(new Option('-id, --device-uuid <value>', 'Set a device UUID').env('IMMICH_DEVICE_UUID'))
  .addOption(
    new Option(
      '-d, --directory <value>',
      'Upload assets recursively from the specified directory (DEPRECATED, use path argument with --recursive instead)',
    ).env('IMMICH_TARGET_DIRECTORY'),
  )
  .argument('[paths...]', 'One or more paths to assets to be uploaded')
  .action((paths, options) => {
    if (options.directory) {
      if (paths.length > 0) {
        log(chalk.red("Error: Can't use deprecated --directory option when specifying paths"));
        process.exit(1);
      }
      if (options.recursive) {
        log(chalk.red("Error: Can't use deprecated --directory option together with --recursive"));
        process.exit(1);
      }
      log(
        chalk.yellow(
          'Warning: deprecated option --directory used, this will be removed in a future release. Please specify paths with --recursive instead',
        ),
      );
      paths.push(options.directory);
      options.recursive = true;
    } else {
      if (paths.length === 0) {
        // If no path argument is given, check if an env variable is set
        const envPath = process.env.IMMICH_ASSET_PATH;
        if (!envPath) {
          log(chalk.red('Error: Must specify at least one path'));
          process.exit(1);
        } else {
          paths = [envPath];
        }
      }
    }
    upload(paths, options);
  });

  program
  .command('delete')
  .description('Delete assets from an Immich instance')
  .usage('delete [options] <paths...>')
  .addOption(new Option('-k, --key <value>', 'API Key').env('IMMICH_API_KEY'))
  .addOption(
    new Option(
      '-s, --server <value>',
      'Immich server address (http://<your-ip>:2283/api or https://<your-domain>/api)',
    ).env('IMMICH_SERVER_ADDRESS'),
  )
  .addOption(new Option('-y, --yes', 'Assume yes on all interactive prompts').env('IMMICH_ASSUME_YES'))
  .addOption(
    new Option('-t, --threads <num>', 'Amount of concurrent upload threads (default=5)').env('IMMICH_UPLOAD_THREADS'),
  )
  .addOption(
    new Option('-al, --album [album]', 'Album\'s image to delete. This will delete images in the specified album only.').env(
      'IMMICH_DELETE_ALBUMS_IMAGE',
    ),
  )
  .addOption(
    new Option('-d, --date [date]', 'Images of this date will be deleted. If you provided time with the date then 24 hours from that time will be considered.').env(
      'IMMICH_DELETE_DATE',
    ),
  )
  .addOption(
    new Option('-dll, --date_lower_limit [date_lower_limit]', 'Time bucket\'s lower limit').env(
      'IMMICH_DELETE_DATE_LOWER_LIMIT',
    ),
  )
  .addOption(
    new Option('-dul, --date_upper_limit [date_upper_limit]', 'Time bucket\'s upper limit.').env(
      'IMMICH_DELETE_DATE_UPPER_LIMIT',
    ),
  )
  .addOption(new Option('-id, --device-uuid <value>', 'Set a device UUID').env('IMMICH_DEVICE_UUID'))
  .action((options) => {
    if (options?.album == undefined && options?.date_lower_limit == undefined && options?.date_upper_limit == undefined && options?.date == undefined) {
      log( chalk.red( "Error: Either specify --all option to delete all assets, or provide one of the following asset: --album, -date, --date_lower_limit, --date_upper_limit" ) );
      process.exit(1);
    }
    delete_assets(options);
  });

program.parse(process.argv);

async function delete_assets(
  {
    key,
    server,
    recursive,
    yes: assumeYes,
    threads: uploadThreads,
    album,
    date: deleteDate,
    date_lower_limit: dateLowerLimit,
    date_upper_limit: dateUpperLimit,
    deviceUuid: deviceUuid,
  }: any,
) {
  const endpoint = server;
  const deviceId = deviceUuid || (await si.uuid()).os || 'CLI';
  const osInfo = (await si.osInfo()).distro;

  let timeLowerLimitEpoch: any = ( dateLowerLimit == undefined ) ? undefined : Date.parse(dateLowerLimit);
  let timeUpperLimitEpoch: any = ( dateUpperLimit == undefined ) ? undefined : Date.parse(dateUpperLimit);

  if ( deleteDate != undefined ) {
    dateLowerLimit = deleteDate;
    dateUpperLimit = deleteDate;
    timeLowerLimitEpoch = Date.parse(deleteDate);
    timeUpperLimitEpoch = new Date(deleteDate);
    timeUpperLimitEpoch.setUTCHours(timeUpperLimitEpoch.getUTCHours() + 23, timeUpperLimitEpoch.getUTCMinutes() + 59, timeUpperLimitEpoch.getUTCSeconds() + 59);
  }

  if ( Number.isNaN( timeLowerLimitEpoch ) || Number.isNaN( timeUpperLimitEpoch ) ) {
    log(chalk.red(`Invalid date format.`));
    process.exit(1);
  }

  // Ping server
  log('Checking connectivity with Immich instance...');
  await pingServer(endpoint);

  // Login
  log('Checking credentials...');
  const user = await validateConnection(endpoint, key);
  log(chalk.green(`Successful authentication for user ${user.email}`));

  const assetsToDelete: string[] = [];

  // Get the assets to be deleted.
  if (album) {
    const album_info = await get_album_info(key, server, album);

    album_info?.assets.forEach((el: any) => {
      // Check if the asset is within the desired time bucket.
      if ( timeLowerLimitEpoch != undefined && timeLowerLimitEpoch > new Date(el.fileCreatedAt).getTime() ) {
        return;
      }
      if ( timeUpperLimitEpoch != undefined && timeUpperLimitEpoch < new Date(el.fileCreatedAt).getTime() ) {
        return;
      }
      assetsToDelete.push( el.id );
    });
  } else {
    const assets_by_time_bucket = await get_assets_by_time_bucket(key, server, dateLowerLimit, dateUpperLimit);

    assets_by_time_bucket.forEach((el: any) => {
      // Check if the asset is within the desired time bucket.
      if ( timeLowerLimitEpoch != undefined && timeLowerLimitEpoch > new Date(el.fileCreatedAt).getTime() ) {
        return;
      }
      if ( timeUpperLimitEpoch != undefined && timeUpperLimitEpoch < new Date(el.fileCreatedAt).getTime() ) {
        return;
      }
      assetsToDelete.push( el.id );
    });
  }

  log(
    chalk.green(
      `A total of ${assetsToDelete.length} assets found to be deleted.`
    ),
  );

  if ( assetsToDelete.length == 0 ) {
    process.exit(0);
  }

  // Ask user
  try {
    //There is a promise API for readline, but it's currently experimental
    //https://nodejs.org/api/readline.html#promises-api
    const answer = assumeYes
      ? 'y'
      : await new Promise((resolve) => {
          rl.question('Do you want to start deletion now? (y/n) ', resolve);
        });

    if (answer == 'n') {
      log(chalk.yellow('Abort Delete Process'));
      process.exit(1);
    }

    if (answer == 'y') {
      log(chalk.green('Start deleting...'));
      const progressBar = new cliProgress.SingleBar(
        {
          format: 'Delete Progress | {bar} | {percentage}% || {value}/{total}',
        },
        cliProgress.Presets.shades_classic,
      );
      progressBar.start(Math.ceil(assetsToDelete.length/20), 0);

      const deleteQueue: any[] = [];

      const limit = pLimit(uploadThreads ?? 5);

      var deletePayload: string[] = [];

      assetsToDelete.forEach((asset, index) => {
        deletePayload.push(asset);

        if (deletePayload.length >= 20 || index >= assetsToDelete.length - 1) {
          const deletePayloadBatch = deletePayload;
          deleteQueue.push(
            limit(async () => {
              try {
                const config: AxiosRequestConfig<any> = {
                  method: 'delete',
                  maxRedirects: 0,
                  url: `${server}/asset`,
                  headers: {
                    'x-api-key': key,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                  },
                  data: JSON.stringify({
                    ids: deletePayloadBatch
                  }),
                  maxContentLength: Infinity,
                  maxBodyLength: Infinity,
                };

                await axios(config);

                progressBar.increment(1);
              } catch (err) {
                log(chalk.red(err.message));
              }
            }),
          );

          deletePayload = [];
        }
      });

      await Promise.all(deleteQueue);

      progressBar.stop();

      for (const error of errorAssets) {
        log("Error asset: ", error)
      }

      if (errorAssets.length > 0) {
        process.exit(1);
      }

      process.exit(0);
    }
  } catch (e) {
    log(chalk.red('Error reading input from user '), e);
    process.exit(1);
  }
}

async function get_assets_by_time_bucket(
  key: string,
  server: string,
  timeLowerLimit: string|undefined,
  timeUpperLimit: string|undefined
) {
  const timeBucket: string[] = dateRange(timeLowerLimit, timeUpperLimit);

  let payload = {
    timeBucket,
    withoutThumbs: false
  };

  try {
    const config: AxiosRequestConfig<any> = {
      method: 'post',
      maxRedirects: 0,
      url: `${server}/asset/time-bucket`,
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: JSON.stringify(payload),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    const res = await axios(config);

    return res.data;
  } catch (error) {
    log(chalk.red('Error: Fetching assets by time bucket.'));
    process.exit(1);
  }
}

async function get_album_info(
  key: string,
  server: string,
  album: string
) {
  try {
    const config: AxiosRequestConfig<any> = {
      method: 'get',
      maxRedirects: 0,
      url: `${server}/album/${album}`,
      headers: {
        'x-api-key': key,
        'Accept': 'application/json'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    const res = await axios(config);

    return res.data;
  } catch (error) {
    log(chalk.red('Error: Fetching assets by album.'));
    process.exit(1);
  }
}

function dateRange(
  startDate: string|undefined,
  endDate: string|undefined
) {
  const startDateEpoch = (startDate == undefined) ? Date.now() : Date.parse(startDate);
  const endDateEpoch = (endDate == undefined) ? Date.now() : Date.parse(endDate);

  if ( Number.isNaN( startDateEpoch ) || Number.isNaN( endDateEpoch ) ) {
    log(chalk.red(`Invalid date format.`));
    process.exit(1);
  }

  let startDateParsed = moment(startDateEpoch);
  let endDateParsed   = moment(endDateEpoch);

  var dates = [];

  var month = moment(startDateParsed);

  if ( month > endDateParsed ) {
    log(chalk.red('Error: Upper limit can\'t be less than lower limit.'))
    process.exit(1);
  }

  while( month <= endDateParsed ) {
      dates.push(new Date(month.format('YYYY-MM-01')).toISOString());
      month.add(1, "month");
  }
  return dates;
}

async function upload(
  paths: string[],
  {
    key,
    server,
    recursive,
    yes: assumeYes,
    delete: deleteAssets,
    uploadThreads,
    album: createAlbums,
    deviceUuid: deviceUuid,
    import: doImport,
  }: any,
) {
  const endpoint = server;
  const deviceId = deviceUuid || (await si.uuid()).os || 'CLI';
  const osInfo = (await si.osInfo()).distro;
  const localAssets: any[] = [];

  // Ping server
  log('Checking connectivity with Immich instance...');
  await pingServer(endpoint);

  // Login
  log('Checking credentials...');
  const user = await validateConnection(endpoint, key);
  log(chalk.green(`Successful authentication for user ${user.email}`));

  // Index provided directory
  log('Indexing local assets...');

  let crawler = new fdir().withFullPaths();

  if (!recursive) {
    // Don't go into subfolders
    crawler = crawler.withMaxDepth(0);
  }

  const files: any[] = [];

  for (const newPath of paths) {
    try {
      // Check if the path can be accessed
      fs.accessSync(newPath);
    } catch (e) {
      log(chalk.red(e));
      process.exit(1);
    }

    const stats = fs.lstatSync(newPath);

    if (stats.isDirectory()) {
      // Path is a directory so use the crawler to crawl it (potentially very large list)
      const children = crawler.crawl(newPath).sync() as PathsOutput;
      for (const child of children) {
        files.push(child);
      }
    } else {
      // Path is a single file
      files.push(path.resolve(newPath));
    }
  }

  // Ensure that list of files only has unique entries
  const uniqueFiles = new Set(files);

  for (const filePath of uniqueFiles) {
    const mimeType = mime.lookup(filePath) as string;
    if (SUPPORTED_MIME.includes(mimeType)) {
      try {
        const fileStat = fs.statSync(filePath);
        localAssets.push({
          id: `${path.basename(filePath)}-${fileStat.size}`.replace(/\s+/g, ''),
          filePath,
        });
      } catch (e) {
        errorAssets.push({
          file: filePath,
          reason: e,
          response: e.response?.data,
        });
        continue;
      }
    }
  }
  if (localAssets.length == 0) {
    log('No local assets found, exiting');
    process.exit(0);
  }

  log(`Indexing complete, found ${localAssets.length} local assets`);

  log('Comparing local assets with those on the Immich instance...');

  const backupAsset = await getAssetInfoFromServer(endpoint, key, deviceId);

  const newAssets = localAssets.filter((a) => !backupAsset.includes(a.id));
  if (localAssets.length == 0 || (newAssets.length == 0 && !createAlbums)) {
    log(chalk.green('All assets have been backed up to the server'));
    process.exit(0);
  } else {
    log(chalk.green(`A total of ${newAssets.length} assets will be uploaded to the server`));
  }

  if (createAlbums) {
    log(
      chalk.green(
        `A total of ${localAssets.length} assets will be added to album(s).\n` +
          'NOTE: some assets may already be associated with the album, this will not create duplicates.',
      ),
    );
  }

  // Ask user
  try {
    //There is a promise API for readline, but it's currently experimental
    //https://nodejs.org/api/readline.html#promises-api
    const answer = assumeYes
      ? 'y'
      : await new Promise((resolve) => {
          rl.question('Do you want to start upload now? (y/n) ', resolve);
        });
    const deleteLocalAsset = deleteAssets ? 'y' : 'n';

    if (answer == 'n') {
      log(chalk.yellow('Abort Upload Process'));
      process.exit(1);
    }

    if (answer == 'y') {
      log(chalk.green('Start uploading...'));
      const progressBar = new cliProgress.SingleBar(
        {
          format: 'Upload Progress | {bar} | {percentage}% || {value}/{total} || Current file [{filepath}]',
        },
        cliProgress.Presets.shades_classic,
      );
      progressBar.start(localAssets.length, 0, { filepath: '' });

      const assetDirectoryMap: Map<string, string[]> = new Map();

      const uploadQueue = [];

      const limit = pLimit(uploadThreads ?? 5);

      for (const asset of localAssets) {
        const album = asset.filePath.split(path.sep).slice(-2)[0];
        if (!assetDirectoryMap.has(album)) {
          assetDirectoryMap.set(album, []);
        }

        if (!backupAsset.includes(asset.id)) {
          // New file, lets upload it!
          uploadQueue.push(
            limit(async () => {
              try {
                const res = await startUpload(endpoint, key, asset, deviceId, doImport);
                progressBar.increment(1, { filepath: asset.filePath });
                if (res && (res.status == 201 || res.status == 200)) {
                  if (deleteLocalAsset == 'y') {
                    fs.unlink(asset.filePath, (err) => {
                      if (err) {
                        log(err);
                        return;
                      }
                    });
                  }
                  backupAsset.push(asset.id);
                  assetDirectoryMap.get(album)!.push(res!.data.id);
                }
              } catch (err) {
                log(chalk.red(err.message));
              }
            }),
          );
        } else if (createAlbums) {
          // Existing file. No need to upload it BUT lets still add to Album.
          uploadQueue.push(
            limit(async () => {
              try {
                // Fetch existing asset from server
                const res = await axios.post(
                  `${endpoint}/asset/check`,
                  {
                    deviceAssetId: asset.id,
                    deviceId,
                  },
                  {
                    headers: { 'x-api-key': key },
                  },
                );
                assetDirectoryMap.get(album)!.push(res!.data.id);
              } catch (err) {
                log(chalk.red(err.message));
              }
            }),
          );
        }
      }

      const uploads = await Promise.all(uploadQueue);

      progressBar.stop();

      if (createAlbums) {
        log(chalk.green('Creating albums...'));

        const serverAlbums = await getAlbumsFromServer(endpoint, key);

        if (typeof createAlbums === 'boolean') {
          progressBar.start(assetDirectoryMap.size, 0);

          for (const localAlbum of assetDirectoryMap.keys()) {
            const serverAlbumIndex = serverAlbums.findIndex((album: any) => album.albumName === localAlbum);
            let albumId: string;
            if (serverAlbumIndex > -1) {
              albumId = serverAlbums[serverAlbumIndex].id;
            } else {
              albumId = await createAlbum(endpoint, key, localAlbum);
            }

            if (albumId) {
              await addAssetsToAlbum(endpoint, key, albumId, assetDirectoryMap.get(localAlbum)!);
            }

            progressBar.increment();
          }

          progressBar.stop();
        } else {
          const serverAlbumIndex = serverAlbums.findIndex((album: any) => album.albumName === createAlbums);
          let albumId: string;

          if (serverAlbumIndex > -1) {
            albumId = serverAlbums[serverAlbumIndex].id;
          } else {
            albumId = await createAlbum(endpoint, key, createAlbums);
          }

          await addAssetsToAlbum(endpoint, key, albumId, Array.from(assetDirectoryMap.values()).flat());
        }
      }

      // log(chalk.yellow(`Failed to upload ${errorAssets.length} files `), errorAssets);

      for (const error of errorAssets) {
        console.log("Error asset: ", error)
      }

      if (errorAssets.length > 0) {
        process.exit(1);
      }

      process.exit(0);
    }
  } catch (e) {
    log(chalk.red('Error reading input from user '), e);
    process.exit(1);
  }
}

async function startUpload(endpoint: string, key: string, asset: any, deviceId: string, doImport: boolean) {
  try {
    const assetType = getAssetType(asset.filePath);
    const fileStat = await stat(asset.filePath);

    const data: any = {
      deviceAssetId: asset.id,
      deviceId,
      assetType,
      fileCreatedAt: fileStat.mtime.toISOString(),
      fileModifiedAt: fileStat.mtime.toISOString(),
      isFavorite: String(false),
      fileExtension: path.extname(asset.filePath),
      duration: '0:00:00.000000',
      isReadOnly: doImport ? String(true) : String(false),
    }

    const formData = new FormData()
    if (!doImport) {
      for (const prop in data) {
        formData.append(prop, data[prop])
      }

      formData.append("assetData", fs.createReadStream(asset.filePath));
    } else {
      data.assetPath = asset.filePath;
    }

    try {
      await fs.promises.access(`${asset.filePath}.xmp`, fs.constants.W_OK);
      if (doImport) {
        data.sidecarPath = path.resolve(`${asset.filePath}.xmp`)
      } else {
        formData.append("sidecarData", fs.createReadStream(path.resolve(`${asset.filePath}.xmp`)), { contentType: 'application/xml' });
      }
    } catch (e) {}

    const config: AxiosRequestConfig<any> = {
      method: 'post',
      maxRedirects: 0,
      url: doImport == true ? `${endpoint}/asset/import` : `${endpoint}/asset/upload`,
      headers: {
        'x-api-key': key,
        ...(doImport == false && formData.getHeaders()),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data: doImport ? data : formData,
    };

    const res = await axios(config);
    return res;
  } catch (e) {
    errorAssets.push({
      file: asset.filePath,
      reason: e,
      response: e.response?.data,
    });
    return null;
  }
}

async function getAlbumsFromServer(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/album`, {
      headers: { 'x-api-key': key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red('Error getting albums'), e);
    process.exit(1);
  }
}

async function createAlbum(endpoint: string, key: string, albumName: string) {
  try {
    const res = await axios.post(
      `${endpoint}/album`,
      { albumName },
      {
        headers: { 'x-api-key': key },
      },
    );
    return res.data.id;
  } catch (e) {
    log(chalk.red(`Error creating album '${albumName}'`), e);
  }
}

async function addAssetsToAlbum(endpoint: string, key: string, albumId: string, assetIds: string[]) {
  try {
    await axios.put(
      `${endpoint}/album/${albumId}/assets`,
      { assetIds: [...new Set(assetIds)] },
      {
        headers: { 'x-api-key': key },
      },
    );
  } catch (e) {
    log(chalk.red('Error adding asset to album'), e);
  }
}

async function getAssetInfoFromServer(endpoint: string, key: string, deviceId: string) {
  try {
    const res = await axios.get(`${endpoint}/asset/${deviceId}`, {
      headers: { 'x-api-key': key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting device's uploaded assets"));
    process.exit(1);
  }
}

async function pingServer(endpoint: string) {
  try {
    const res = await axios.get(`${endpoint}/server-info/ping`);
    if (res.data['res'] == 'pong') {
      log(chalk.green('Server status: OK'));
    }
  } catch (e) {
    log(chalk.red('Error connecting to server - check server address and port'));
    process.exit(1);
  }
}

async function validateConnection(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/user/me`, {
      headers: { 'x-api-key': key },
    });

    if (res.status == 200) {
      log(chalk.green('Login status: OK'));
      return res.data;
    }
  } catch (e) {
    log(chalk.red('Error logging in - check api key'));
    process.exit(1);
  }
}

function getAssetType(filePath: string) {
  const mimeType = mime.lookup(filePath) as string;

  return mimeType.split('/')[0].toUpperCase();
}
