import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import MonitorOverrideModal from '@app/components/MonitorOverrideModal';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  BellAlertIcon,
  BellSlashIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  TrashIcon,
  XCircleIcon,
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
    'Current status of monitored services. Tap "Notify me" on a downed service to receive a push notification once it’s back online.',
  announcements: 'Announcements',
  postedBy: 'Posted by {name}',
  retract: 'Remove this announcement',
  retractFailed: 'Could not remove the announcement.',
  retractSuccess: 'Announcement removed.',
  monitorUp: 'Operational',
  monitorDown: 'Down',
  monitorPaused: 'Paused',
  monitorUnknown: 'Unknown',
  manualOperational: 'Operational',
  manualMaintenance: 'Scheduled Maintenance',
  manualDegraded: 'Degraded Performance',
  manualPartialOutage: 'Partial Outage',
  manualMajorOutage: 'Major Outage',
  manualUntil: 'Until {time}',
  notifyMe: 'Notify me',
  notifying: 'Subscribed',
  cancel: 'Cancel notification',
  overrideOpen: 'Override status',
  clearSuppression: 'Resume reports',
  clearSuppressionSuccess: 'Reports are no longer suppressed.',
  clearSuppressionFailed: 'Could not lift the suppression.',
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
  reportProblem: 'Report a Problem',
  reportTitle: 'Report a Problem',
  reportDescription:
    'Check off any services you’re having trouble with. The administrator will be notified, and other people will see that you’re also having issues.',
  reportSubmit: 'Submit',
  reportSubmitting: 'Submitting…',
  reportNoSelection: 'Select at least one service.',
  reportSuccess:
    '{count, plural, one {Submitted. The administrator has been notified.} other {Submitted. The administrator has been notified about your # reports.}}',
  reportAllAlready:
    'You’ve already reported all the services you selected. The administrator was already notified.',
  reportFailed: 'Could not submit the report.',
  reportSuppressed:
    'Problem reports are paused for a planned maintenance window.',
  reportCount:
    '{count, plural, one {# other person is reporting an issue} other {# other people are reporting an issue}}',
  reportCountSelf:
    '{count, plural, one {You and # other are reporting an issue} other {You and # others are reporting an issue}}',
  reportFirst: 'You’re the first to report an issue',
  resolveAll: 'Mark all reports for this service resolved',
  resolveAllSuccess: 'Reports cleared.',
  resolveAllFailed: 'Could not clear reports.',
});

type ManualStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

interface StatusMonitor {
  id: number;
  name: string;
  defaultName?: string;
  description?: string;
  url: string;
  type: number;
  status: 'up' | 'down' | 'paused' | 'unknown';
  rawStatus: number;
  manualStatus?: ManualStatus;
  manualStatusUntil?: number;
  hideFromReports?: boolean;
}

export interface StatusResponse {
  configured: boolean;
  lastFetched: number;
  monitors: StatusMonitor[];
  subscribedMonitorIds: number[];
  fetchError?: string;
  reportsSuppressedUntil?: number | null;
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

interface ReportCount {
  monitorId: number;
  name: string;
  count: number;
  userReported?: boolean;
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

  const { data: reportCounts, mutate: revalidateReports } = useSWR<
    ReportCount[]
  >('/api/v1/uptimerobot/reports', { refreshInterval: 60000 });

  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportSelection, setReportSelection] = useState<Set<number>>(
    new Set()
  );
  const [reportSubmitting, setReportSubmitting] = useState(false);

  const [overrideMonitor, setOverrideMonitor] = useState<StatusMonitor | null>(
    null
  );
  const [clearingSuppression, setClearingSuppression] = useState(false);

  const isAdmin = hasPermission(Permission.ADMIN);

  const clearSuppression = async () => {
    setClearingSuppression(true);
    try {
      await axios.delete('/api/v1/uptimerobot/suppression');
      addToast(intl.formatMessage(messages.clearSuppressionSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      await revalidate();
    } catch {
      addToast(intl.formatMessage(messages.clearSuppressionFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setClearingSuppression(false);
    }
  };

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

  const toggleReportSelection = (monitorId: number) => {
    setReportSelection((prev) => {
      const next = new Set(prev);
      if (next.has(monitorId)) next.delete(monitorId);
      else next.add(monitorId);
      return next;
    });
  };

  const submitReport = async () => {
    if (reportSelection.size === 0) {
      addToast(intl.formatMessage(messages.reportNoSelection), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }
    setReportSubmitting(true);
    try {
      const response = await axios.post<{
        created: number;
        alreadyReported: number;
      }>('/api/v1/uptimerobot/reports', {
        monitorIds: [...reportSelection],
      });
      const { created, alreadyReported } = response.data;
      if (created === 0 && alreadyReported > 0) {
        addToast(intl.formatMessage(messages.reportAllAlready), {
          appearance: 'info',
          autoDismiss: true,
        });
      } else {
        addToast(
          intl.formatMessage(messages.reportSuccess, { count: created }),
          { appearance: 'success', autoDismiss: true }
        );
      }
      setReportModalOpen(false);
      setReportSelection(new Set());
      await revalidateReports();
    } catch (e) {
      const suppressed =
        axios.isAxiosError(e) &&
        e.response?.status === 409 &&
        (e.response.data as { suppressed?: boolean } | undefined)?.suppressed;
      addToast(
        intl.formatMessage(
          suppressed ? messages.reportSuppressed : messages.reportFailed
        ),
        { appearance: 'error', autoDismiss: true }
      );
      if (suppressed) {
        await revalidate();
      }
    } finally {
      setReportSubmitting(false);
    }
  };

  const resolveReportsForMonitor = async (monitorId: number) => {
    try {
      await axios.post(
        `/api/v1/uptimerobot/reports/resolve?monitorId=${monitorId}`
      );
      addToast(intl.formatMessage(messages.resolveAllSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      await revalidateReports();
    } catch {
      addToast(intl.formatMessage(messages.resolveAllFailed), {
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
      <div className="mb-4 flex flex-col justify-between gap-2 lg:flex-row lg:items-end">
        <div className="min-w-0">
          <Header>{intl.formatMessage(messages.statusTitle)}</Header>
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.statusDescription)}
          </p>
        </div>
        {data?.configured && data.monitors.length > 0 && (
          <div className="flex flex-shrink-0">
            <Button
              buttonType="warning"
              type="button"
              onClick={() => {
                setReportSelection(new Set());
                setReportModalOpen(true);
              }}
              disabled={
                !!data.reportsSuppressedUntil &&
                data.reportsSuppressedUntil > Date.now()
              }
              data-testid="status-report-problem"
            >
              <ExclamationTriangleIcon />
              <span>{intl.formatMessage(messages.reportProblem)}</span>
            </Button>
          </div>
        )}
      </div>

      {data?.reportsSuppressedUntil &&
        data.reportsSuppressedUntil > Date.now() && (
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <Alert
                type="info"
                title={intl.formatMessage(messages.reportSuppressed)}
              />
            </div>
            {isAdmin && (
              <div className="flex flex-shrink-0">
                <Button
                  buttonType="warning"
                  type="button"
                  disabled={clearingSuppression}
                  onClick={clearSuppression}
                  data-testid="status-clear-suppression"
                >
                  <XCircleIcon />
                  <span>{intl.formatMessage(messages.clearSuppression)}</span>
                </Button>
              </div>
            )}
          </div>
        )}

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
              const manualActive =
                monitor.manualStatus &&
                monitor.manualStatusUntil &&
                monitor.manualStatusUntil > Date.now();
              const statusColor = manualActive
                ? monitor.manualStatus === 'operational'
                  ? 'success'
                  : monitor.manualStatus === 'maintenance'
                    ? 'warning'
                    : 'danger'
                : monitor.status === 'up'
                  ? 'success'
                  : monitor.status === 'down'
                    ? 'danger'
                    : monitor.status === 'paused'
                      ? 'warning'
                      : 'default';
              const statusLabel = manualActive
                ? intl.formatMessage(
                    monitor.manualStatus === 'operational'
                      ? messages.manualOperational
                      : monitor.manualStatus === 'maintenance'
                        ? messages.manualMaintenance
                        : monitor.manualStatus === 'degraded'
                          ? messages.manualDegraded
                          : monitor.manualStatus === 'partial_outage'
                            ? messages.manualPartialOutage
                            : messages.manualMajorOutage
                  )
                : monitor.status === 'up'
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
                        manualActive
                          ? monitor.manualStatus === 'operational'
                            ? 'bg-green-500'
                            : monitor.manualStatus === 'maintenance'
                              ? 'bg-yellow-500'
                              : 'animate-pulse bg-red-500'
                          : monitor.status === 'up'
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
                      {manualActive && monitor.manualStatusUntil && (
                        <div className="mt-1 text-xs uppercase tracking-wide text-gray-400">
                          {intl.formatMessage(messages.manualUntil, {
                            time: intl.formatTime(
                              new Date(monitor.manualStatusUntil),
                              { timeStyle: 'short' }
                            ),
                          })}
                        </div>
                      )}
                      {monitor.description &&
                        !manualActive &&
                        !(reportCounts ?? []).some(
                          (r) => r.monitorId === monitor.id && r.count > 0
                        ) && (
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
                      {(() => {
                        const report = (reportCounts ?? []).find(
                          (r) => r.monitorId === monitor.id
                        );
                        if (!report || report.count === 0) return null;
                        const otherCount =
                          report.count - (report.userReported ? 1 : 0);
                        const text = report.userReported
                          ? otherCount === 0
                            ? intl.formatMessage(messages.reportFirst)
                            : intl.formatMessage(messages.reportCountSelf, {
                                count: otherCount,
                              })
                          : intl.formatMessage(messages.reportCount, {
                              count: report.count,
                            });
                        return (
                          <div className="mt-2 flex items-center gap-2 text-xs text-yellow-300">
                            <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                            <span>{text}</span>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() =>
                                  resolveReportsForMonitor(monitor.id)
                                }
                                title={intl.formatMessage(messages.resolveAll)}
                                aria-label={intl.formatMessage(
                                  messages.resolveAll
                                )}
                                className="text-yellow-300 transition hover:text-white"
                              >
                                <TrashIcon className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  <Badge badgeType={statusColor} className="text-sm sm:ml-2">
                    {statusLabel}
                  </Badge>
                  {isAdmin && (
                    <Button
                      buttonType="ghost"
                      type="button"
                      onClick={() => setOverrideMonitor(monitor)}
                      title={intl.formatMessage(messages.overrideOpen)}
                      aria-label={intl.formatMessage(messages.overrideOpen)}
                      data-testid={`status-override-${monitor.id}`}
                    >
                      <PencilSquareIcon />
                    </Button>
                  )}
                  {monitor.status === 'down' && recoveryEnabled && !isAdmin && (
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

      <Transition
        as="div"
        show={reportModalOpen}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(messages.reportTitle)}
          onCancel={() => setReportModalOpen(false)}
          onOk={() => submitReport()}
          okText={
            reportSubmitting
              ? intl.formatMessage(messages.reportSubmitting)
              : intl.formatMessage(messages.reportSubmit)
          }
          okButtonType="primary"
          okDisabled={reportSubmitting || reportSelection.size === 0}
        >
          <p className="mb-4 text-sm text-gray-300">
            {intl.formatMessage(messages.reportDescription)}
          </p>
          {(() => {
            const reportable = (data?.monitors ?? []).filter(
              (m) => !m.hideFromReports
            );
            if (!reportable.length) {
              return (
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.noMonitors)}
                </p>
              );
            }
            return (
              <ul className="space-y-2">
                {reportable.map((monitor) => {
                  const isChecked = reportSelection.has(monitor.id);
                  return (
                    <li key={monitor.id}>
                      <label
                        htmlFor={`report-monitor-${monitor.id}`}
                        className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm text-white transition duration-150 ${
                          isChecked
                            ? 'border-indigo-500 bg-indigo-600/20'
                            : 'border-gray-700 bg-gray-800/60 hover:border-gray-500 hover:bg-gray-700/60'
                        }`}
                      >
                        <input
                          id={`report-monitor-${monitor.id}`}
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleReportSelection(monitor.id)}
                        />
                        <span className="truncate">{monitor.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            );
          })()}
        </Modal>
      </Transition>

      <MonitorOverrideModal
        isOpen={!!overrideMonitor}
        presetMonitor={
          overrideMonitor
            ? {
                id: overrideMonitor.id,
                name: overrideMonitor.name,
                manualStatus: overrideMonitor.manualStatus,
                manualStatusUntil: overrideMonitor.manualStatusUntil,
              }
            : null
        }
        monitors={(data?.monitors ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          manualStatus: m.manualStatus,
          manualStatusUntil: m.manualStatusUntil,
        }))}
        onClose={() => setOverrideMonitor(null)}
        onApplied={() => {
          revalidate();
          revalidateReports();
        }}
      />
    </>
  );
};

export default Status;
