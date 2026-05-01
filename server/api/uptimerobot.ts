import ExternalAPI from './externalapi';

export const UPTIMEROBOT_STATUS = {
  PAUSED: 0,
  NOT_CHECKED: 1,
  UP: 2,
  SEEMS_DOWN: 8,
  DOWN: 9,
} as const;

export type UptimeRobotStatusCode =
  (typeof UPTIMEROBOT_STATUS)[keyof typeof UPTIMEROBOT_STATUS];

export const UPTIMEROBOT_TYPE = {
  HTTP: 1,
  KEYWORD: 2,
  PING: 3,
  PORT: 4,
  HEARTBEAT: 5,
} as const;

export interface UptimeRobotMonitor {
  id: number;
  friendly_name: string;
  url: string;
  type: number;
  status: UptimeRobotStatusCode;
  /** Seconds since UNIX epoch. */
  create_datetime: number;
  custom_uptime_ratio?: string;
  /** Logs are only included when the corresponding flag is sent in the request. */
  logs?: {
    type: number;
    datetime: number;
    duration: number;
    reason?: { code?: string; detail?: string };
  }[];
}

interface PaginationData {
  offset: number;
  limit: number;
  total: number;
}

interface GetMonitorsResponse {
  stat: 'ok' | 'fail';
  pagination?: PaginationData;
  monitors?: UptimeRobotMonitor[];
  error?: { type?: string; message?: string };
}

class UptimeRobotAPI extends ExternalAPI {
  private apiKey: string;

  constructor(apiKey: string) {
    super(
      'https://api.uptimerobot.com/v2',
      {},
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'cache-control': 'no-cache',
        },
        timeout: 15000,
      }
    );
    this.apiKey = apiKey;
  }

  /**
   * Fetch monitors. UptimeRobot's API uses `application/x-www-form-urlencoded`
   * POST bodies, so we serialize parameters into a URLSearchParams body
   * rather than sending JSON.
   */
  public async getMonitors(
    options: { logs?: boolean } = {}
  ): Promise<UptimeRobotMonitor[]> {
    const monitors: UptimeRobotMonitor[] = [];
    const limit = 50;
    let offset = 0;

    while (true) {
      const body = new URLSearchParams();
      body.append('api_key', this.apiKey);
      body.append('format', 'json');
      body.append('offset', String(offset));
      body.append('limit', String(limit));
      if (options.logs) {
        body.append('logs', '1');
        body.append('logs_limit', '1');
      }

      const response = await this.axios.post<GetMonitorsResponse>(
        '/getMonitors',
        body.toString()
      );

      if (response.data.stat !== 'ok') {
        const message =
          response.data.error?.message ??
          response.data.error?.type ??
          'Unknown error';
        throw new Error(`[UptimeRobot] API error: ${message}`);
      }

      monitors.push(...(response.data.monitors ?? []));

      const pagination = response.data.pagination;
      if (
        !pagination ||
        monitors.length >= pagination.total ||
        (response.data.monitors ?? []).length < limit
      ) {
        break;
      }
      offset += limit;
    }

    return monitors;
  }
}

export default UptimeRobotAPI;
