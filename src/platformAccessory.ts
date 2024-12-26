import type { CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';

import type { EOMiniPlatform } from './platform.js';

import PQueue from 'p-queue';

import { ResponseMini, ResponseSession } from './api.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class ChargerAccessory {
  private lockService: Service;
  private outletService: Service;
  private contactSensorService: Service;

  private log: Logging;

  private device: ResponseMini;
  private session: ResponseSession | null = null;
  private sessionAlive: boolean = false;
  private lastUpdated: Date;

  private queue: PQueue;

  private states: {
    LockCurrentState: number;
    LockTargetState: number;
    On: boolean;
    ContactSensorState: number;
  };

  constructor(private readonly platform: EOMiniPlatform, private readonly accessory: PlatformAccessory) {
    this.log = this.platform.log;

    this.device = this.accessory.context.device;
    this.lastUpdated = new Date();

    this.queue = this.platform.queue;

    this.states = {
      LockCurrentState: this.platform.Characteristic.LockCurrentState.UNSECURED,
      LockTargetState: this.platform.Characteristic.LockTargetState.UNSECURED,
      On: false,
      ContactSensorState: this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    };

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'EO')
      .setCharacteristic(this.platform.Characteristic.Model, this.device.chargerModel + '')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.chargerAddress + '');

    this.lockService =
      this.accessory.getService(this.platform.Service.LockMechanism) ||
      this.accessory.addService(this.platform.Service.LockMechanism);

    this.lockService
      .getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.lockService
      .getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    this.outletService =
      this.accessory.getService(this.platform.Service.Outlet) ||
      this.accessory.addService(this.platform.Service.Outlet);

    this.outletService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOutletOn.bind(this))
      .onSet(this.setOutletOn.bind(this));

    this.contactSensorService =
      this.accessory.getService(this.platform.Service.ContactSensor) ||
      this.accessory.addService(this.platform.Service.ContactSensor);

    this.contactSensorService
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.getContactSensorState.bind(this));

    this.checkSession();

    setInterval(() => {
      if (this.queue.size + this.queue.pending > 0) {
        this.log.debug(this.device.address, 'Skipping update (queue is not empty)');
        return;
      }
      if (this.accessory.context.lastUpdated <= this.lastUpdated) {
        return;
      }

      this.log.debug(this.device.address, 'Checking for updates', this.accessory.context.lastUpdated, this.lastUpdated);

      this.device = this.accessory.context.device;
      this.lastUpdated = new Date();

      this.checkSession();
    }, 1000);
  }

  printStateInfo<
    K extends keyof typeof this.states & keyof (typeof this.platform)['Characteristic'],
    V extends (typeof this.states)[K],
  >(state: K, value: V) {
    const from = Object.entries(this.platform.Characteristic[state]).find(([, v]) => v === this.states[state]) || [
      this.states[state],
    ];
    const to = Object.entries(this.platform.Characteristic[state]).find(([, v]) => v === value) || [value];

    this.log.info(this.device.address, state, from[0], '->', to[0]);
  }

  updateState<
    K extends keyof typeof this.states & keyof (typeof this.platform)['Characteristic'],
    V extends (typeof this.states)[K],
  >(
    service: 'lock' | 'outlet' | 'contactSensor',
    state: K,
    value: V,
    skipCharacteristicUpdate = false,
    forced = false,
  ) {
    if (value === this.states[state] && !forced) {
      this.log.debug(this.device.address, 'Ignoring update', state, this.states[state], '->', value);
      return;
    }

    this.printStateInfo(state, value);

    this.states[state] = value;

    if (skipCharacteristicUpdate) {
      return;
    }

    switch (service) {
      case 'lock':
        this.lockService.updateCharacteristic(this.platform.Characteristic[state], value);
        break;
      case 'outlet':
        this.outletService.updateCharacteristic(this.platform.Characteristic[state], value);
        break;
      case 'contactSensor':
        this.contactSensorService.updateCharacteristic(this.platform.Characteristic[state], value);
        break;
    }
  }

  checkSession() {
    this.log.debug(this.device.address, 'Check session');

    this.queue.add(async () => {
      this.session = await this.platform.client.session();
      this.sessionAlive = await this.platform.client.sessionAlive();

      this.computeAll();
    });
  }

  computeAll() {
    this.log.debug(this.device.address, 'Computing all');

    this.updateState('lock', 'LockCurrentState', this.computeLockCurrentState());
    this.updateState('lock', 'LockTargetState', this.computeLockCurrentState(), true);
    this.updateState('outlet', 'On', this.computeOutletOn());
    this.updateState('contactSensor', 'ContactSensorState', this.computeContactSensorState());
  }

  computeLockCurrentState() {
    return this.device.isDisabled === 1
      ? this.platform.Characteristic.LockCurrentState.SECURED
      : this.platform.Characteristic.LockCurrentState.UNSECURED;
  }

  getLockCurrentState() {
    return this.states.LockCurrentState;
  }

  getLockTargetState() {
    return this.states.LockTargetState;
  }

  async doEnableOrDisable(action: 'Enable' | 'Disable') {
    this.log.info(this.device.address, 'Attempt to', action, this.device.address);

    await this.platform.client[`mini${action}`](this.device.address);

    this.log.info(this.device.address, 'Complete to', action, this.device.address);
  }

  async setLockTargetState(value: CharacteristicValue) {
    if (value === this.states.LockTargetState || value === this.states.LockCurrentState) {
      this.log.debug(this.device.address, 'Ignoring setLockTargetState', value, this.states);
      return;
    }

    this.updateState('lock', 'LockTargetState', value as number);

    let promise: Promise<unknown> | null = null;

    switch (value) {
      case this.platform.Characteristic.LockTargetState.SECURED:
        promise = this.doEnableOrDisable('Disable');
        break;
      case this.platform.Characteristic.LockTargetState.UNSECURED:
        promise = this.doEnableOrDisable('Enable');
        break;
      default:
        this.log.error(this.device.address, 'Unknown LockTargetState', value);
        return;
    }

    this.queue.add(async () => {
      try {
        await promise;

        this.updateState('lock', 'LockCurrentState', value as number);
      } catch (err) {
        this.log.error(this.device.address, 'Failed to enable/disable', err);

        this.updateState('lock', 'LockCurrentState', this.platform.Characteristic.LockCurrentState.UNKNOWN);
      }
    });
  }

  async doPauseOrUnpause(action: 'Pause' | 'Unpause') {
    this.log.info(this.device.address, 'Attempt to', action, this.device.address);

    await this.platform.client[`session${action}`]();

    this.log.info(this.device.address, 'Complete to', action, this.device.address);
  }

  computeOutletOn() {
    if (!this.session) {
      return false;
    }

    return !this.session.IsPaused;
  }

  getOutletOn() {
    return this.states.On;
  }

  resettingOutletOff: boolean = false;
  resetOutletOff() {}

  setOutletOn(value: CharacteristicValue) {
    if (!this.sessionAlive) {
      if (this.resettingOutletOff) {
        this.resettingOutletOff = false;
        return;
      }

      this.log.warn(this.device.address, 'Session not alive', value, this.states);
      this.resettingOutletOff = true;
      setTimeout(() => {
        this.updateState('outlet', 'On', false, true);
        this.outletService.getCharacteristic(this.platform.Characteristic.On).setValue(false);
      }, 150);
      return;
    }

    if (value === this.states.On) {
      this.log.debug(this.device.address, 'Ignoring setOutletOn', value, this.states);
      return;
    }

    this.updateState('outlet', 'On', value as boolean, false);

    let promise: Promise<unknown> | null = null;

    switch (value) {
      case false:
        promise = this.doPauseOrUnpause('Pause');
        break;
      case true:
        promise = this.doPauseOrUnpause('Unpause');
        break;
      default:
        this.log.error(this.device.address, 'Unknown On', value);
        return;
    }

    this.queue.add(async () => {
      try {
        await promise;
      } catch (err) {
        this.log.error(this.device.address, 'Failed to pause/unpause', err);
      }
    });
  }

  computeContactSensorState() {
    if (this.sessionAlive) {
      this.log.debug('Contact detected');
      return this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    this.log.debug('Contact NOT detected');
    return this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  getContactSensorState() {
    return this.states.ContactSensorState;
  }
}
