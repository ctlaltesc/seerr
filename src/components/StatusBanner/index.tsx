import Button from '@app/components/Common/Button';
import type { StatusResponse } from '@app/components/Status';
import defineMessages from '@app/utils/defineMessages';
import {
  BellAlertIcon,
  BellSlashIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages('components.StatusBanner', {
  servicesDown:
    '{count, plural, one {# service is currently down} other {# services are currently down}}',
  notifyMe: 'Notify me when it’s back up',
  notifying: 'Subscribed',
  cancel: 'Cancel',
  viewStatus: 'View status page',
  subscribeFailed: 'Could not subscribe to recovery notifications.',
  unsubscribeFailed: 'Could not cancel the recovery notification.',
});

const StatusBanner = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [busy, setBusy] = useState<number | null>(null);

  const { data, mutate } = useSWR<StatusResponse>('/api/v1/status', {
    refreshInterval: 60000,
  });

  if (!data || !data.configured) return null;

  const downMonitors = data.monitors.filter((m) => m.status === 'down');
  if (downMonitors.length === 0) return null;

  const subscribed = new Set(data.subscribedMonitorIds);

  const toggle = async (monitorId: number, isSubscribed: boolean) => {
    setBusy(monitorId);
    try {
      if (isSubscribed) {
        await axios.delete(`/api/v1/status/subscribe/${monitorId}`);
      } else {
        await axios.post(`/api/v1/status/subscribe/${monitorId}`);
      }
      await mutate();
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

  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-red-500 bg-red-600/20 backdrop-blur">
      <div className="flex items-start gap-3 px-4 py-3">
        <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="text-sm font-semibold text-red-100">
              {intl.formatMessage(messages.servicesDown, {
                count: downMonitors.length,
              })}
            </p>
            <Link
              href="/status"
              className="text-xs font-medium text-red-200 transition hover:text-white hover:underline"
            >
              {intl.formatMessage(messages.viewStatus)} →
            </Link>
          </div>
          <ul className="mt-2 space-y-2">
            {downMonitors.map((monitor) => {
              const isSubscribed = subscribed.has(monitor.id);
              return (
                <li
                  key={monitor.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`status-banner-monitor-${monitor.id}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">
                      {monitor.name}
                    </div>
                    {monitor.description && (
                      <div className="text-xs text-red-100/90">
                        {monitor.description}
                      </div>
                    )}
                    {monitor.url && (
                      <div className="truncate text-xs text-red-200/60">
                        {monitor.url}
                      </div>
                    )}
                  </div>
                  <Button
                    buttonType={isSubscribed ? 'ghost' : 'primary'}
                    buttonSize="sm"
                    type="button"
                    disabled={busy === monitor.id}
                    onClick={() => toggle(monitor.id, isSubscribed)}
                    data-testid={`status-banner-notify-${monitor.id}`}
                  >
                    {isSubscribed ? <BellSlashIcon /> : <BellAlertIcon />}
                    <span className="ml-1">
                      {isSubscribed
                        ? intl.formatMessage(messages.cancel)
                        : intl.formatMessage(messages.notifyMe)}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default StatusBanner;
