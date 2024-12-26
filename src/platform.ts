import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { ChargerAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import { EoMiniApi } from './api.js';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class EOMiniPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly devices: Map<string, string> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  public _client: EoMiniApi | undefined = undefined;

  private timeout: NodeJS.Timeout | undefined = undefined;

  constructor(public readonly log: Logging, public readonly config: PlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // only load if configured
    if (!config) {
      this.log.warn('Missing config to initialize platform:', this.config.name);
      return;
    }
    if (!this.config.username) {
      this.log.error('Missing username to initialize platform:', this.config.name);
      return;
    }
    if (!this.config.password) {
      this.log.error('Missing password to initialize platform:', this.config.name);
      return;
    }

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  get client() {
    this._client = this._client || new EoMiniApi(this.config.username, this.config.password, this.log);

    return this._client;
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  async listDevices() {
    return await this.client.miniList();
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const devices = await this.listDevices();

    // clear devices map
    this.devices.clear();

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.address);

      // map device id to uuid
      this.devices.set(device.address, uuid);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        existingAccessory.context.device = device;
        existingAccessory.context.lastUpdated = new Date();
        existingAccessory.displayName = device.address;

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
        // existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        new ChargerAccessory(this, existingAccessory);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.address);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.address, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;
        accessory.context.lastUpdated = new Date();
        accessory.displayName = device.address;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        new ChargerAccessory(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  async updateDevices() {
    if (this.timeout) {
      clearInterval(this.timeout);
    }

    this.log.debug('Updating devices');

    const devices = await this.listDevices();

    for (const device of devices) {
      const uuid = this.devices.get(device.address);

      if (!uuid) {
        this.log.error('Device not found', device.address);
        continue;
      }

      const existingAccessory = this.accessories.get(uuid);

      if (!existingAccessory) {
        this.log.error('Accessory not found', uuid);
        continue;
      }

      existingAccessory.context.device = device;
      existingAccessory.context.lastUpdated = new Date();

      // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
      // existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);
    }

    this.timeout = setInterval(() => {
      setImmediate(() => {
        this.updateDevices();
      });
    }, this.config.refreshRate * 1000);
  }
}
