import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import MonitorRow from '@app/components/Settings/SettingsStatus/MonitorRow';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useEffect, useMemo, useState } from 'react';
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
  monitorOrder: 'Monitors',
  monitorOrderTip:
    'Drag a monitor by its handle to reorder it. Edit the name to override the label users see, and add a short description to give context. Leave a field blank to keep the UptimeRobot default.',
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
});

type ManualStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

interface MonitorOverride {
  id: number;
  name?: string;
  description?: string;
  hideUrl?: boolean;
  hidden?: boolean;
  hideFromReports?: boolean;
  manualStatus?: ManualStatus;
  manualStatusUntil?: number;
}

interface SettingsResponse {
  enabled: boolean;
  apiKey: string;
  apiKeySet: boolean;
  monitorOrder: number[];
  monitorOverrides: MonitorOverride[];
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
  const [overrides, setOverrides] = useState<Record<number, MonitorOverride>>(
    {}
  );

  const monitorsById = useMemo(() => {
    const map = new Map<number, MonitorPreview>();
    (monitorList ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [monitorList]);

  useEffect(() => {
    if (!data || !monitorList) return;
    const knownIds = new Set(monitorList.map((m) => m.id));

    // Order: saved order minus deleted monitors, then any new monitors.
    const ordered = data.monitorOrder.filter((id) => knownIds.has(id));
    monitorList.forEach((m) => {
      if (!ordered.includes(m.id)) ordered.push(m.id);
    });
    setOrderedIds(ordered);

    // Overrides: drop entries for monitors that no longer exist.
    const next: Record<number, MonitorOverride> = {};
    for (const o of data.monitorOverrides ?? []) {
      if (knownIds.has(o.id)) {
        next[o.id] = {
          id: o.id,
          name: o.name ?? '',
          description: o.description ?? '',
          hideUrl: !!o.hideUrl,
          hidden: !!o.hidden,
          hideFromReports: !!o.hideFromReports,
          manualStatus: o.manualStatus,
          manualStatusUntil: o.manualStatusUntil,
        };
      }
    }
    setOverrides(next);
  }, [data, monitorList]);

  const handleMove = (
    draggedId: number,
    targetId: number,
    position: 'Above' | 'Below'
  ) => {
    if (draggedId === targetId) return;
    setOrderedIds((current) => {
      const next = current.filter((id) => id !== draggedId);
      const targetIndex = next.indexOf(targetId);
      if (targetIndex === -1) return current;
      const insertAt = position === 'Above' ? targetIndex : targetIndex + 1;
      next.splice(insertAt, 0, draggedId);
      return next;
    });
  };

  const handleNameChange = (id: number, name: string) => {
    setOverrides((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { id }), id, name },
    }));
  };

  const handleDescriptionChange = (id: number, description: string) => {
    setOverrides((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { id }), id, description },
    }));
  };

  const handleHideUrlChange = (id: number, hideUrl: boolean) => {
    setOverrides((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { id }), id, hideUrl },
    }));
  };

  const handleHiddenChange = (id: number, hidden: boolean) => {
    setOverrides((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { id }), id, hidden },
    }));
  };

  const handleHideFromReportsChange = (
    id: number,
    hideFromReports: boolean
  ) => {
    setOverrides((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { id }), id, hideFromReports },
    }));
  };

  const handleManualStatusChange = (
    id: number,
    status: ManualStatus | undefined,
    minutes: number
  ) => {
    setOverrides((current) => {
      const existing = current[id] ?? { id };
      if (!status) {
        return {
          ...current,
          [id]: {
            ...existing,
            id,
            manualStatus: undefined,
            manualStatusUntil: undefined,
          },
        };
      }
      const safeMinutes = Math.max(1, Math.min(1440, Math.round(minutes) || 1));
      return {
        ...current,
        [id]: {
          ...existing,
          id,
          manualStatus: status,
          manualStatusUntil: Date.now() + safeMinutes * 60_000,
        },
      };
    });
  };

  if (!data && !error) return <LoadingSpinner />;
  if (!data) return null;

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
            const now = Date.now();
            const cleanedOverrides = Object.values(overrides)
              .map((o) => {
                const manualActive =
                  o.manualStatus &&
                  typeof o.manualStatusUntil === 'number' &&
                  o.manualStatusUntil > now;
                return {
                  id: o.id,
                  name: o.name?.trim() || undefined,
                  description: o.description?.trim() || undefined,
                  hideUrl: o.hideUrl ? true : undefined,
                  hidden: o.hidden ? true : undefined,
                  hideFromReports: o.hideFromReports ? true : undefined,
                  manualStatus: manualActive ? o.manualStatus : undefined,
                  manualStatusUntil: manualActive
                    ? o.manualStatusUntil
                    : undefined,
                };
              })
              .filter(
                (o) =>
                  o.name ||
                  o.description ||
                  o.hideUrl ||
                  o.hidden ||
                  o.hideFromReports ||
                  o.manualStatus
              );

            const payload: Partial<SettingsResponse> & { apiKey?: string } = {
              enabled: values.enabled,
              recoveryNotificationsEnabled: values.recoveryNotificationsEnabled,
              recoveryStableMinutes: Number(values.recoveryStableMinutes) || 10,
              pollIntervalSeconds: Number(values.pollIntervalSeconds) || 60,
              monitorOrder: orderedIds,
              monitorOverrides: cleanedOverrides,
            };
            if (values.apiKey) payload.apiKey = values.apiKey;

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
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    id="recoveryStableMinutes"
                    name="recoveryStableMinutes"
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
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    id="pollIntervalSeconds"
                    name="pollIntervalSeconds"
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
                    <div className="space-y-2">
                      {orderedIds.map((id) => {
                        const monitor = monitorsById.get(id);
                        if (!monitor) return null;
                        const override = overrides[id];
                        return (
                          <MonitorRow
                            key={id}
                            monitor={{
                              id: monitor.id,
                              defaultName: monitor.name,
                              url: monitor.url,
                              status: monitor.status,
                              name: override?.name ?? '',
                              description: override?.description ?? '',
                              hideUrl: !!override?.hideUrl,
                              hidden: !!override?.hidden,
                              hideFromReports: !!override?.hideFromReports,
                              manualStatus: override?.manualStatus,
                              manualStatusUntil: override?.manualStatusUntil,
                            }}
                            onNameChange={handleNameChange}
                            onDescriptionChange={handleDescriptionChange}
                            onHideUrlChange={handleHideUrlChange}
                            onHiddenChange={handleHiddenChange}
                            onHideFromReportsChange={
                              handleHideFromReportsChange
                            }
                            onManualStatusChange={handleManualStatusChange}
                            onMove={handleMove}
                          />
                        );
                      })}
                    </div>
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
