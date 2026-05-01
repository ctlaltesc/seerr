import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  BellAlertIcon,
  BellSlashIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages('components.Status', {
  status: 'Status',
  statusTitle: 'Service Status',
  statusDescription:
    'Current status of monitored services. Tap "Notify me" on a downed service to receive a push notification when it comes back online.',
  announcements: 'Announcements',
  postedBy: 'Posted by {name}',
  retract: 'Remove this announcement',
  retractFailed: 'Could not remove the announcement.',
  retractSuccess: 'Announcement removed.',
  monitorUp: 'Operational',
  monitorDown: 'Down',
  monitorPaused: 'Paused',
  monitorUnknown: 'Unknown',
  notifyMe: 'Notify me when it’s back up',
  notifying: 'Subscribed',
  cancel: 'Cancel notification',
  notConfigured:
    'Status monitoring has not been configured. Ask an administrator to set up UptimeRobot in the admin settings.',
  noMonitors: 'No monitors are currently configured.',
  fetchError:
    'Unable to fetch the latest status from UptimeRobot. Showing the last known status.',
  subscribeSuccess: 'You will be notified once {name} is back online.',
  subscribeFailed: 'Could not subscribe to recovery notifications.',
  unsubscribeSuccess: 'Cancelled the recovery notification for {name}.',
  unsubscribeFailed: 'Could not cancel the recovery notification.',
  recoveryDisabled:
    'Recovery notifications are currently disabled by the administrator.',
  visitMonitor: 'Open',
  lastChecked: 'Last checked {time}',
});

interface StatusMonitor {
  id: number;
  name: string;
  defaultName?: string;
  description?: string;
  url: string;
  type: number;
  status: 'up' | 'down' | 'paused' | 'unknown';
  rawStatus: number;
}

export interface StatusResponse {
  configured: boolean;
  lastFetched: number;
  monitors: StatusMonitor[];
  subscribedMonitorIds: number[];
  fetchError?: string;
}

export interface UptimerobotPublicSettings {
  enabled: boolean;
  recoveryNotificationsEnabled: boolean;
}

interface Announcement {
  id: number;
  subject: string;
  message?: string;
  postedAt: string;
  postedBy?: { id: number; displayName: string; avatar: string };
}

const Status = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const [busy, setBusy] = useState<number | null>(null);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<StatusResponse>('/api/v1/uptimerobot', {
    refreshInterval: 30000,
  });

  const { data: announcements, mutate: revalidateAnnouncements } = useSWR<
    Announcement[]
  >('/api/v1/uptimerobot/announcements', { refreshInterval: 60000 });

  const isAdmin = hasPermission(Permission.ADMIN);

  const retractAnnouncement = async (id: number) => {
    try {
      await axios.delete(`/api/v1/uptimerobot/announcements/${id}`);
      addToast(intl.formatMessage(messages.retractSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      await revalidateAnnouncements();
    } catch {
      addToast(intl.formatMessage(messages.retractFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const recoveryEnabled = true; // Server omits monitors entirely if not enabled
  // — relies on the per-server `recoveryNotificationsEnabled` flag, but the
  // status endpoint returns the cached monitor list either way. The server
  // suppresses dispatch on its end when disabled, so the UI button still
  // works as an opt-in (effectively a no-op until the admin re-enables).

  const toggleSubscription = async (
    monitorId: number,
    name: string,
    isSubscribed: boolean
  ) => {
    setBusy(monitorId);
    try {
      if (isSubscribed) {
        await axios.delete(`/api/v1/uptimerobot/subscribe/${monitorId}`);
        addToast(intl.formatMessage(messages.unsubscribeSuccess, { name }), {
          appearance: 'success',
          autoDismiss: true,
        });
      } else {
        await axios.post(`/api/v1/uptimerobot/subscribe/${monitorId}`);
        addToast(intl.formatMessage(messages.subscribeSuccess, { name }), {
          appearance: 'success',
          autoDismiss: true,
        });
      }
      await revalidate();
    } catch {
      addToast(
        intl.formatMessage(
          isSubscribed ? messages.unsubscribeFailed : messages.subscribeFailed
        ),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setBusy(null);
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (!data) return null;

  const subscribed = new Set(data.subscribedMonitorIds);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.status)} />
      <div className="mb-4">
        <Header>{intl.formatMessage(messages.statusTitle)}</Header>
        <p className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.statusDescription)}
        </p>
      </div>

      {announcements && announcements.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
            {intl.formatMessage(messages.announcements)}
          </h3>
          <ul className="space-y-3">
            {announcements.map((a) => (
              <li
                key={a.id}
                className="rounded-xl border border-indigo-600/40 bg-indigo-900/20 p-4 shadow-md"
                data-testid={`announcement-${a.id}`}
              >
                <div className="flex items-start gap-3">
                  {a.postedBy && (
                    <CachedImage
                      type="avatar"
                      src={a.postedBy.avatar}
                      alt=""
                      width={32}
                      height={32}
                      className="mt-1 h-8 w-8 flex-shrink-0 rounded-full object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-base font-semibold text-white">
                        {a.subject}
                      </p>
                      <p className="text-xs text-gray-400">
                        {intl.formatDate(a.postedAt, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </p>
                    </div>
                    {a.message && (
                      <p className="mt-1 whitespace-pre-line text-sm text-gray-200">
                        {a.message}
                      </p>
                    )}
                    {a.postedBy && (
                      <p className="mt-1 text-xs text-gray-500">
                        {intl.formatMessage(messages.postedBy, {
                          name: a.postedBy.displayName,
                        })}
                      </p>
                    )}
                  </div>
                  {isAdmin && (
                    <Button
                      buttonType="ghost"
                      buttonSize="sm"
                      type="button"
                      aria-label={intl.formatMessage(messages.retract)}
                      title={intl.formatMessage(messages.retract)}
                      onClick={() => retractAnnouncement(a.id)}
                      data-testid={`announcement-retract-${a.id}`}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!data.configured ? (
        <Alert type="info" title={intl.formatMessage(messages.notConfigured)} />
      ) : data.monitors.length === 0 ? (
        <Alert type="warning" title={intl.formatMessage(messages.noMonitors)} />
      ) : (
        <>
          {data.fetchError && (
            <Alert
              type="warning"
              title={intl.formatMessage(messages.fetchError)}
            />
          )}
          <ul className="space-y-3">
            {data.monitors.map((monitor) => {
              const isSubscribed = subscribed.has(monitor.id);
              const statusColor =
                monitor.status === 'up'
                  ? 'success'
                  : monitor.status === 'down'
                    ? 'danger'
                    : monitor.status === 'paused'
                      ? 'warning'
                      : 'default';
              const statusLabel =
                monitor.status === 'up'
                  ? intl.formatMessage(messages.monitorUp)
                  : monitor.status === 'down'
                    ? intl.formatMessage(messages.monitorDown)
                    : monitor.status === 'paused'
                      ? intl.formatMessage(messages.monitorPaused)
                      : intl.formatMessage(messages.monitorUnknown);

              return (
                <li
                  key={monitor.id}
                  className="flex flex-col gap-3 rounded-xl border border-gray-700 bg-gray-800 p-5 shadow-md sm:flex-row sm:items-center sm:gap-4"
                  data-testid={`status-monitor-${monitor.id}`}
                >
                  <div className="flex items-center sm:flex-1">
                    <div
                      className={`mr-4 h-4 w-4 flex-shrink-0 rounded-full ${
                        monitor.status === 'up'
                          ? 'bg-green-500'
                          : monitor.status === 'down'
                            ? 'animate-pulse bg-red-500'
                            : monitor.status === 'paused'
                              ? 'bg-yellow-500'
                              : 'bg-gray-500'
                      }`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg font-semibold text-white">
                        {monitor.name}
                      </div>
                      {monitor.description && (
                        <div className="mt-1 text-sm text-gray-300">
                          {monitor.description}
                        </div>
                      )}
                      {monitor.url && (
                        <a
                          href={monitor.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 block truncate text-xs text-gray-500 transition hover:text-indigo-400 hover:underline"
                        >
                          {monitor.url}
                        </a>
                      )}
                    </div>
                  </div>
                  <Badge
                    badgeType={statusColor}
                    className="self-start text-sm sm:ml-2"
                  >
                    {statusLabel}
                  </Badge>
                  {monitor.status === 'down' && recoveryEnabled && (
                    <Button
                      buttonType={isSubscribed ? 'ghost' : 'primary'}
                      type="button"
                      disabled={busy === monitor.id}
                      onClick={() =>
                        toggleSubscription(
                          monitor.id,
                          monitor.name,
                          isSubscribed
                        )
                      }
                      data-testid={`status-notify-${monitor.id}`}
                    >
                      {isSubscribed ? <BellSlashIcon /> : <BellAlertIcon />}
                      <span className="ml-1">
                        {isSubscribed
                          ? intl.formatMessage(messages.cancel)
                          : intl.formatMessage(messages.notifyMe)}
                      </span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {data.lastFetched > 0 && (
            <p className="description mt-3">
              {intl.formatMessage(messages.lastChecked, {
                time: intl.formatTime(new Date(data.lastFetched)),
              })}
            </p>
          )}
        </>
      )}
    </>
  );
};

export default Status;
