import { Logging } from 'homebridge';
import fetch from 'node-fetch';

interface RequestOpts {
  expect?: boolean;
  headers?: Record<string, string>;
  body?: string;
}

interface Response<B extends object> {
  ok: boolean;
  status: number;
  body: B;
  rawBody: string;
}

export interface ResponseToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  userName: string;
  '.issued': string;
  '.expires': string;
}

interface AuthSession {
  token: string;
  expires: Date;
  header: {
    Authorization: `Bearer ${string}`;
  };
  raw: ResponseToken;
}

export interface ResponseUser {
  title: string;
  firstName: string;
  lastName: string;
  userType: number;
  host: number;
  email: string;
  mobile: number;
  foc: number;
  isDemo: number;
  trVer: string;
  ppVer: string;
  pushUpdated: number;
  appSetup: number;
  homeHost: number;
  AID: number;
  distanceUnits: number;
  address: string;
  countryCode: string;
  chargeDefs: {
    chargeStart: number;
    chargeEnd: number;
    chargeMin: number;
    solarMode: number;
    timeMode: number;
  };
  chargeOpts: object;
  currency: {
    code: string;
    symbol: string;
    decimals: number;
  };
}

export interface ResponseMini {
  address: string;
  isDisabled: number;
  ct1: number;
  ct2: number;
  ct3: number;
  advertisedRate: number;
  voltage: number;
  timezone: string;
  chargerAddress: string;
  hubAddress: string;
  chargerModel: number;
  hubModel: number;
  hubSerial: string;
}

export interface ResponseMiniStatus {
  hubStatus: string;
  miniStatus: string;
}

export interface ResponseSession {
  USID: number;
  CPID: number;
  PiTime: number;
  ESTime: number;
  ESCost: number;
  ESKWH: number;
  ChargingTime: number;
  PayR1: number;
  PayR2: number;
  PayR3: number;
  PayR4: number;
  ULoc: string;
  Location: string;
  Voltage: number;
  IsPaused: boolean;
  IsOverridden: boolean;
}

export interface ResponseVehicle {
  ID: number;
  Manufacturer: string;
  Model: string;
  Year: number;
  Range: 210;
  BatteryKWH: number;
}

export class AuthError extends Error {
  isAuthError = true;

  constructor(message: string, readonly status: number, readonly body: string) {
    super(`Authentication failed: ${message}`);

    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

export class EoMiniApi {
  private base = 'https://eoappi.eocharging.com';

  /**
   * Object containing the auth session
   */
  private _authSession: AuthSession | undefined = undefined;

  constructor(private readonly username: string, private readonly password: string, private log: Logging) {}

  /**
   * Flag to check if the auth session is valid
   */
  private get isAuthSessionValid() {
    return !this._authSession || this._authSession.expires > new Date();
  }

  /**
   * Get the auth session header (if valid)
   */
  private get authSessionHeader() {
    if (!this.isAuthSessionValid) {
      return undefined;
    }

    return this._authSession?.header;
  }

  /**
   * Set the auth session
   */
  private set authSession(raw: ResponseToken) {
    this._authSession = {
      token: raw.access_token,
      expires: new Date(Date.now() + raw.expires_in * 1000),
      header: {
        Authorization: `Bearer ${raw.access_token}`,
      },
      raw,
    };
  }

  /**
   *
   */
  private async auth() {
    const resp = await fetch(`${this.base}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: ['grant_type=password', `username=${this.username}`, `password=${this.password}`].join('&'),
    });

    const rawBody = await resp.text();

    // ! Fail if response is not ok
    if (!resp.ok) {
      throw new AuthError('Response not ok', resp.status, rawBody);
    }

    // * Attempt to parse the response body as JSON
    let body: ResponseToken;
    try {
      body = JSON.parse(rawBody) as ResponseToken;
    } catch (err) {
      throw new AuthError('Response not JSON', resp.status, rawBody);
    }

    // ! Fail if access_token property is not available
    if (!body.access_token) {
      throw new AuthError('No access token', resp.status, rawBody);
    }
    // ! Fail if expires_in property is not available
    if (!body.expires_in) {
      throw new AuthError('No expiration time', resp.status, rawBody);
    }

    // * Store the auth session
    this.authSession = body;

    // ! Fail if the auth session header is not available
    // * This is a last resort check
    if (!this.authSessionHeader) {
      throw new AuthError('No auth session header', resp.status, rawBody);
    }
  }

  /**
   * Make a request
   * @param method HTTP Method
   * @param endpoint Endpoint to request
   * @param opts Options
   * @returns Response
   */
  private async request<T extends object = object>(
    method: 'GET' | 'POST',
    endpoint: string,
    { expect = true, headers = {}, body = undefined }: RequestOpts = {},
  ): Promise<Response<T>> {
    // ! Always auth if the auth session header is not available
    if (!this.authSessionHeader) {
      await this.auth();
    }

    const url = `${this.base}/${endpoint}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.authSessionHeader,
        ...headers,
      },
      body,
    });

    const rawBody = await resp.text();

    this.log.debug('Response', resp.status, resp.ok, rawBody);

    if (!resp.ok) {
      throw new Error('Request failed: ' + rawBody);
    }

    let respBody = {} as T;

    // * Attempt to parse the response body as JSON when expected
    if (expect) {
      try {
        respBody = JSON.parse(rawBody) as T;
      } catch (err) {
        throw new Error('Response not JSON: ' + rawBody);
      }
    }

    return {
      ok: resp.ok,
      status: resp.status,
      body: respBody,
      rawBody,
    };
  }

  /**
   * Retrieve authenticated user
   * @returns User info
   */
  async user() {
    const { body } = await this.request<ResponseUser>('GET', 'api/user');

    return body;
  }

  /**
   * List all EO Mini chargers (expect always one)
   * @returns EO Mini list
   */
  async miniList() {
    const { body } = await this.request<ResponseMini[]>('GET', 'api/mini/list');

    return body;
  }

  /**
   * Healthcheck status
   * @param address EO Mini Address
   */
  async miniStatus(address: string) {
    const { body } = await this.request<ResponseMiniStatus>('GET', `api/mini/status?address=${address}`);

    if (!body.hubStatus.match(/^2..$/i)) {
      throw new Error(`HUB not connected (${body.hubStatus})`);
    }
    if (!body.miniStatus.match(/^2..$/i)) {
      throw new Error(`MINI not connected (${body.miniStatus})`);
    }
  }

  async miniEnable(address: string) {
    await this.request<object>('POST', 'api/mini/enable', {
      expect: false,
      body: `id=${address}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async miniDisable(address: string) {
    await this.request<object>('POST', 'api/mini/disable', {
      expect: false,
      body: `id=${address}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async session() {
    const { body } = await this.request<ResponseSession>('GET', 'api/session');

    return body;
  }

  /**
   * Cable/Vehicle connected
   */
  async sessionAlive() {
    try {
      await this.request<object>('GET', 'api/session/alive', { expect: false });

      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Unpause charging
   */
  async sessionUnpause() {
    await this.request<ResponseSession>('POST', 'api/session/unpause', { expect: false });
  }

  /**
   * Pause charging
   */
  async sessionPause() {
    await this.request<ResponseSession>('POST', 'api/session/Pause', { expect: false });
  }

  async vehicle() {
    const { body } = await this.request<ResponseVehicle>('GET', 'api/vehicle');

    return body;
  }
}
