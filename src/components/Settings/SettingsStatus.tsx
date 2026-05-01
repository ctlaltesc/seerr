import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownIcon,
  ArrowDownOnSquareIcon,
  ArrowUpIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsStatus', {
  status: 'Status',
  statusSettings: 'Status Page',
  statusSettingsDescription:
    'Configure UptimeRobot to power the status page and the home page banner. Once configured, all logged-in users can view monitor status, and any user can opt in to a push notification when a downed service is back online.',
  apiKey: 'UptimeRobot API Key',
  apiKeyTip:
    'Use a Read-Only key. Find or create one at uptimerobot.com → My Settings → API Settings.',
  enabled: 'Enable',
  enabledTip: 'Show the status page and home page banner',
  recoveryEnabled: 'Recovery Notifications',
  recoveryEnabledTip:
    'Push a notification to users who tapped "Notify me when it’s back up" once a downed monitor stays online for the configured stable window',
  stableMinutes: 'Stable Window (minutes)',
  stableMinutesTip:
    'How long a monitor must continuously stay online after recovery before notifications fire. Default 10 minutes.',
  pollSeconds: 'Poll Interval (seconds)',
  pollSecondsTip:
    'How frequently the server polls UptimeRobot. Minimum 30 seconds. Default 60.',
  monitorOrder: 'Monitor Order',
  monitorOrderTip:
    'Drag the arrows to reorder how monitors appear on the status page. New monitors are appended to the end automatically.',
  noMonitors:
    'No monitors found. Save the API key first, or check that your UptimeRobot account has monitors configured.',
  testKey: 'Test Key',
  testing: 'Testing…',
  testSuccess:
    'Connected to UptimeRobot. Found {count, plural, one {# monitor} other {# monitors}}.',
  testFailed: 'Could not reach UptimeRobot: {message}',
  saveSuccess: 'Status settings saved.',
  saveFailed: 'Failed to save status settings.',
  validationApiKey: 'API key is required when enabled.',
  moveUp: 'Move up',
  moveDown: 'Move down',
});

interface SettingsResponse {
  enabled: boolean;
  apiKey: string;
  apiKeySet: boolean;
  monitorOrder: number[];
  recoveryNotificationsEnabled: boolean;
  recoveryStableMinutes: number;
  pollIntervalSeconds: number;
}

interface MonitorPreview {
  id: number;
  name: string;
  url: string;
  type: number;
  status: number | string;
}

const SettingsStatus = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);

  const { data, error, mutate } = useSWR<SettingsResponse>(
    '/api/v1/settings/uptimerobot'
  );

  const { data: monitorList, mutate: mutateMonitors } = useSWR<
    MonitorPreview[]
  >(
    data?.enabled && data?.apiKeySet
      ? '/api/v1/settings/uptimerobot/monitors'
      : null
  );

  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const monitorsById = new Map<number, MonitorPreview>();
  (monitorList ?? []).forEach((m) => monitorsById.set(m.id, m));

  useEffect(() => {
    if (!data || !monitorList) return;
    const knownIds = new Set(monitorList.map((m) => m.id));
    // Start from the saved order, dropping monitors that no longer exist.
    const ordered = data.monitorOrder.filter((id) => knownIds.has(id));
    // Append any new monitors that aren't in the saved order.
    monitorList.forEach((m) => {
      if (!ordered.includes(m.id)) ordered.push(m.id);
    });
    setOrderedIds(ordered);
  }, [data, monitorList]);

  const move = (index: number, direction: -1 | 1) => {
    const next = [...orderedIds];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrderedIds(next);
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return null;
  }

  const SettingsSchema = Yup.object().shape({
    apiKey: Yup.string().when('enabled', {
      is: true,
      then: (schema) =>
        schema.test(
          'apiKey-required',
          intl.formatMessage(messages.validationApiKey),
          (value) => !!value || data.apiKeySet
        ),
    }),
  });

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.status),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.statusSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.statusSettingsDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          enabled: data.enabled,
          apiKey: '',
          recoveryNotificationsEnabled: data.recoveryNotificationsEnabled,
          recoveryStableMinutes: data.recoveryStableMinutes,
          pollIntervalSeconds: data.pollIntervalSeconds,
        }}
        enableReinitialize
        validationSchema={SettingsSchema}
        onSubmit={async (values) => {
          try {
            const payload: Partial<SettingsResponse> = {
              enabled: values.enabled,
              recoveryNotificationsEnabled: values.recoveryNotificationsEnabled,
              recoveryStableMinutes: Number(values.recoveryStableMinutes) || 10,
              pollIntervalSeconds: Number(values.pollIntervalSeconds) || 60,
              monitorOrder: orderedIds,
            };
            // Only send apiKey when the admin actually changed it; the
            // server treats `undefined` as "leave existing key alone."
            if (values.apiKey) {
              (payload as { apiKey: string }).apiKey = values.apiKey;
            }
            await axios.post('/api/v1/settings/uptimerobot', payload);
            await mutate();
            await mutateMonitors();
            addToast(intl.formatMessage(messages.saveSuccess), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch {
            addToast(intl.formatMessage(messages.saveFailed), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({ errors, touched, isSubmitting, isValid, values }) => (
          <Form className="section" data-testid="settings-status-form">
            <div className="form-row">
              <label htmlFor="enabled" className="checkbox-label">
                {intl.formatMessage(messages.enabled)}
                <span className="label-tip">
                  {intl.formatMessage(messages.enabledTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field type="checkbox" id="enabled" name="enabled" />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="apiKey" className="text-label">
                {intl.formatMessage(messages.apiKey)}
                {values.enabled && !data.apiKeySet && (
                  <span className="label-required">*</span>
                )}
                <span className="label-tip">
                  {intl.formatMessage(messages.apiKeyTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <SensitiveInput
                    as="field"
                    id="apiKey"
                    name="apiKey"
                    type="text"
                    placeholder={data.apiKeySet ? '••••••••' : ''}
                    autoComplete="off"
                  />
                </div>
                {errors.apiKey &&
                  touched.apiKey &&
                  typeof errors.apiKey === 'string' && (
                    <div className="error">{errors.apiKey}</div>
                  )}
                <div className="mt-2">
                  <Button
                    buttonType="warning"
                    type="button"
                    disabled={isTesting || (!values.apiKey && !data.apiKeySet)}
                    onClick={async () => {
                      setIsTesting(true);
                      try {
                        const response = await axios.post<{
                          ok: boolean;
                          monitors: MonitorPreview[];
                        }>('/api/v1/settings/uptimerobot/test', {
                          apiKey: values.apiKey || undefined,
                        });
                        addToast(
                          intl.formatMessage(messages.testSuccess, {
                            count: response.data.monitors.length,
                          }),
                          { appearance: 'success', autoDismiss: true }
                        );
                      } catch (e) {
                        const message =
                          (axios.isAxiosError(e) &&
                            (
                              e.response?.data as
                                | { message?: string }
                                | undefined
                            )?.message) ||
                          (e as Error).message;
                        addToast(
                          intl.formatMessage(messages.testFailed, { message }),
                          { appearance: 'error', autoDismiss: true }
                        );
                      } finally {
                        setIsTesting(false);
                      }
                    }}
                  >
                    <BeakerIcon />
                    <span>
                      {isTesting
                        ? intl.formatMessage(messages.testing)
                        : intl.formatMessage(messages.testKey)}
                    </span>
                  </Button>
                </div>
              </div>
            </div>

            <div className="form-row">
              <label
                htmlFor="recoveryNotificationsEnabled"
                className="checkbox-label"
              >
                {intl.formatMessage(messages.recoveryEnabled)}
                <span className="label-tip">
                  {intl.formatMessage(messages.recoveryEnabledTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="recoveryNotificationsEnabled"
                  name="recoveryNotificationsEnabled"
                />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="recoveryStableMinutes" className="text-label">
                {intl.formatMessage(messages.stableMinutes)}
                <span className="label-tip">
                  {intl.formatMessage(messages.stableMinutesTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    type="number"
                    id="recoveryStableMinutes"
                    name="recoveryStableMinutes"
                    min={0}
                    max={1440}
                    className="short"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="pollIntervalSeconds" className="text-label">
                {intl.formatMessage(messages.pollSeconds)}
                <span className="label-tip">
                  {intl.formatMessage(messages.pollSecondsTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    type="number"
                    id="pollIntervalSeconds"
                    name="pollIntervalSeconds"
                    min={30}
                    max={3600}
                    className="short"
                  />
                </div>
              </div>
            </div>

            {values.enabled && data.apiKeySet && (
              <div className="form-row">
                <span className="text-label">
                  {intl.formatMessage(messages.monitorOrder)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.monitorOrderTip)}
                  </span>
                </span>
                <div className="form-input-area">
                  {!monitorList ? (
                    <LoadingSpinner />
                  ) : orderedIds.length === 0 ? (
                    <Alert
                      type="warning"
                      title={intl.formatMessage(messages.noMonitors)}
                    />
                  ) : (
                    <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-800/50">
                      {orderedIds.map((id, index) => {
                        const monitor = monitorsById.get(id);
                        if (!monitor) return null;
                        const statusBadge = ((): {
                          type: 'success' | 'danger' | 'warning' | 'default';
                          label: string;
                        } => {
                          const raw =
                            typeof monitor.status === 'string'
                              ? monitor.status.toLowerCase()
                              : monitor.status === 2
                                ? 'up'
                                : monitor.status === 8 || monitor.status === 9
                                  ? 'down'
                                  : monitor.status === 0
                                    ? 'paused'
                                    : 'unknown';
                          if (raw === 'up' || raw === 'ok')
                            return { type: 'success', label: 'Up' };
                          if (raw === 'down' || raw === 'seems_down')
                            return { type: 'danger', label: 'Down' };
                          if (raw === 'paused')
                            return { type: 'warning', label: 'Paused' };
                          return { type: 'default', label: 'Unknown' };
                        })();
                        return (
                          <li
                            key={id}
                            className="flex items-center px-4 py-2"
                            data-testid={`monitor-row-${id}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-white">
                                {monitor.name}
                              </div>
                              {monitor.url && (
                                <div className="truncate text-xs text-gray-400">
                                  {monitor.url}
                                </div>
                              )}
                            </div>
                            <Badge
                              badgeType={statusBadge.type}
                              className="ml-2"
                            >
                              {statusBadge.label}
                            </Badge>
                            <div className="ml-3 flex space-x-1">
                              <Button
                                buttonType="default"
                                buttonSize="sm"
                                type="button"
                                disabled={index === 0}
                                onClick={() => move(index, -1)}
                                aria-label={intl.formatMessage(messages.moveUp)}
                                title={intl.formatMessage(messages.moveUp)}
                              >
                                <ArrowUpIcon className="h-4 w-4" />
                              </Button>
                              <Button
                                buttonType="default"
                                buttonSize="sm"
                                type="button"
                                disabled={index === orderedIds.length - 1}
                                onClick={() => move(index, 1)}
                                aria-label={intl.formatMessage(
                                  messages.moveDown
                                )}
                                title={intl.formatMessage(messages.moveDown)}
                              >
                                <ArrowDownIcon className="h-4 w-4" />
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}

            <div className="actions">
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={isSubmitting || !isValid}
                    data-testid="settings-status-save"
                  >
                    <ArrowDownOnSquareIcon />
                    <span>
                      {isSubmitting
                        ? intl.formatMessage(globalMessages.saving)
                        : intl.formatMessage(globalMessages.save)}
                    </span>
                  </Button>
                </span>
              </div>
            </div>
          </Form>
        )}
      </Formik>
    </>
  );
};

export default SettingsStatus;
