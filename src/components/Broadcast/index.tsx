import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import MonitorOverrideModal, {
  type MonitorOption,
} from '@app/components/MonitorOverrideModal';
import type { StatusResponse } from '@app/components/Status';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  AdjustmentsHorizontalIcon,
  MegaphoneIcon,
} from '@heroicons/react/24/outline';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Broadcast', {
  broadcast: 'Broadcast',
  broadcastTitle: 'Broadcast',
  broadcastDescription:
    'Send a custom web push notification to a selection of users or to everyone with push notifications enabled.',
  overrideStatus: 'Override service status',
  overrideStatusTip:
    'Open the manual-status modal to pin a service to Operational, Maintenance, Degraded, etc. Useful when announcing planned maintenance.',
  subject: 'Title',
  subjectPlaceholder: 'Server Maintenance',
  subjectTip: 'The notification headline that recipients will see.',
  message: 'Message',
  messagePlaceholder:
    'The server is going down for maintenance for about 20 minutes.',
  messageTip:
    'The body of the push notification. Leave empty to send only the title.',
  recipients: 'Recipients',
  allUsers: 'All users',
  selectUsers: 'Select users',
  noUsers: 'No users available to broadcast to.',
  send: 'Send Broadcast',
  sending: 'Sending…',
  validationSubject: 'You must provide a title',
  validationSubjectMax: 'Title is too long; should be 120 characters or fewer',
  validationMessageMax:
    'Message is too long; should be 500 characters or fewer',
  validationRecipients: 'Select at least one user, or choose all users.',
  broadcastSuccess:
    'Broadcast sent. Delivered {sent} of {total} push notifications to {recipients} {recipients, plural, one {recipient} other {recipients}}.',
  broadcastNoRecipients:
    'No active push subscriptions were found for the selected recipients.',
  broadcastFailure: 'Something went wrong sending the broadcast.',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  admin: 'Admin',
  owner: 'Owner',
  postToStatus: 'Post to status page',
  postToStatusTip:
    'Show this announcement to everyone visiting the status page until it auto-expires (after 72 hours, or sooner if all monitors stay online for 24 hours).',
  suppressReports: 'Suppress problem reports (minutes)',
  suppressReportsTip:
    'Block users from filing new “Report a problem” submissions for this many minutes. Useful when broadcasting a planned maintenance window. Leave 0 to disable.',
  validationSuppressMax:
    'Maximum suppression window is 1440 minutes (24 hours).',
});

interface BroadcastResponse {
  sent: number;
  failed: number;
  recipients: number;
}

type Audience = 'all' | 'select';

const Broadcast = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user: currentUser } = useUser();
  const [audience, setAudience] = useState<Audience>('all');
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);

  const { data: usersData, error: usersError } = useSWR<UserResultsResponse>(
    '/api/v1/user?take=1000&sort=displayname&sortDirection=asc'
  );

  const { data: statusData, mutate: revalidateStatus } = useSWR<StatusResponse>(
    '/api/v1/uptimerobot'
  );

  const allUsers = useMemo(() => usersData?.results ?? [], [usersData]);

  // The override modal opens to a "blank" picker on Broadcast — admins
  // pick the service inside the modal. Use a sentinel monitor object so
  // the modal's `monitor` prop is non-null (which is what controls the
  // open/closed state).
  const [overrideOpen, setOverrideOpen] = useState(false);
  const overrideMonitors: MonitorOption[] = useMemo(
    () =>
      (statusData?.monitors ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        manualStatus: m.manualStatus,
        manualStatusUntil: m.manualStatusUntil,
      })),
    [statusData]
  );

  const toggleUser = (userId: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  const selectAllUsers = () => {
    setSelectedUserIds(allUsers.map((u) => u.id));
  };

  const clearSelection = () => {
    setSelectedUserIds([]);
  };

  const BroadcastSchema = Yup.object().shape({
    subject: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationSubject))
      .max(120, intl.formatMessage(messages.validationSubjectMax)),
    message: Yup.string().max(
      500,
      intl.formatMessage(messages.validationMessageMax)
    ),
    suppressReportsForMinutes: Yup.number()
      .min(0)
      .max(1440, intl.formatMessage(messages.validationSuppressMax)),
  });

  if (!usersData && !usersError) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.broadcast),
          intl.formatMessage(globalMessages.usersettings),
        ]}
      />

      <div className="mb-4">
        <Header>{intl.formatMessage(messages.broadcastTitle)}</Header>
        <p className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.broadcastDescription)}
        </p>
      </div>

      <Formik
        initialValues={{
          subject: '',
          message: '',
          postToStatus: true,
          suppressReportsForMinutes: 0,
        }}
        validationSchema={BroadcastSchema}
        onSubmit={async (values, { resetForm }) => {
          if (audience === 'select' && selectedUserIds.length === 0) {
            addToast(intl.formatMessage(messages.validationRecipients), {
              appearance: 'error',
              autoDismiss: true,
            });
            return;
          }

          try {
            const response = await axios.post<BroadcastResponse>(
              '/api/v1/user/broadcast',
              {
                subject: values.subject.trim(),
                message: values.message.trim() || undefined,
                userIds: audience === 'select' ? selectedUserIds : undefined,
                postToStatus: values.postToStatus,
                suppressReportsForMinutes:
                  Number(values.suppressReportsForMinutes) || 0,
              }
            );

            const { sent, failed, recipients } = response.data;
            const total = sent + failed;

            if (recipients === 0 || total === 0) {
              addToast(intl.formatMessage(messages.broadcastNoRecipients), {
                appearance: 'warning',
                autoDismiss: true,
              });
            } else {
              addToast(
                intl.formatMessage(messages.broadcastSuccess, {
                  sent,
                  total,
                  recipients,
                }),
                {
                  appearance: 'success',
                  autoDismiss: true,
                }
              );
              resetForm({
                values: {
                  subject: '',
                  message: '',
                  postToStatus: values.postToStatus,
                  suppressReportsForMinutes: 0,
                },
              });
              if (audience === 'select') {
                setSelectedUserIds([]);
              }
            }
          } catch {
            addToast(intl.formatMessage(messages.broadcastFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({ errors, touched, isSubmitting, isValid }) => (
          <Form className="section" data-testid="broadcast-form">
            <div className="form-row">
              <label htmlFor="subject" className="text-label">
                {intl.formatMessage(messages.subject)}
                <span className="label-required">*</span>
                <span className="label-tip">
                  {intl.formatMessage(messages.subjectTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="subject"
                    name="subject"
                    type="text"
                    placeholder={intl.formatMessage(
                      messages.subjectPlaceholder
                    )}
                    autoComplete="off"
                  />
                </div>
                {errors.subject &&
                  touched.subject &&
                  typeof errors.subject === 'string' && (
                    <div className="error">{errors.subject}</div>
                  )}
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="message" className="text-label">
                {intl.formatMessage(messages.message)}
                <span className="label-tip">
                  {intl.formatMessage(messages.messageTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    as="textarea"
                    id="message"
                    name="message"
                    rows={4}
                    className="h-28"
                    placeholder={intl.formatMessage(
                      messages.messagePlaceholder
                    )}
                  />
                </div>
                {errors.message &&
                  touched.message &&
                  typeof errors.message === 'string' && (
                    <div className="error">{errors.message}</div>
                  )}
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="postToStatus" className="checkbox-label">
                {intl.formatMessage(messages.postToStatus)}
                <span className="label-tip">
                  {intl.formatMessage(messages.postToStatusTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field type="checkbox" id="postToStatus" name="postToStatus" />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="suppressReportsForMinutes" className="text-label">
                {intl.formatMessage(messages.suppressReports)}
                <span className="label-tip">
                  {intl.formatMessage(messages.suppressReportsTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="suppressReportsForMinutes"
                    name="suppressReportsForMinutes"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="short"
                  />
                </div>
                {errors.suppressReportsForMinutes &&
                  touched.suppressReportsForMinutes &&
                  typeof errors.suppressReportsForMinutes === 'string' && (
                    <div className="error">
                      {errors.suppressReportsForMinutes}
                    </div>
                  )}
              </div>
            </div>

            <div className="form-row">
              <span className="text-label">
                {intl.formatMessage(messages.recipients)}
              </span>
              <div className="form-input-area">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => setAudience('all')}
                    className={`flex-1 rounded-md border px-4 py-3 text-left text-sm font-medium transition duration-150 ease-in-out ${
                      audience === 'all'
                        ? 'border-indigo-500 bg-indigo-600/30 text-white'
                        : 'border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-500 hover:bg-gray-700'
                    }`}
                  >
                    <div className="flex items-center">
                      <input
                        type="radio"
                        readOnly
                        checked={audience === 'all'}
                        className="mr-3"
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                      <span>{intl.formatMessage(messages.allUsers)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudience('select')}
                    className={`flex-1 rounded-md border px-4 py-3 text-left text-sm font-medium transition duration-150 ease-in-out ${
                      audience === 'select'
                        ? 'border-indigo-500 bg-indigo-600/30 text-white'
                        : 'border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-500 hover:bg-gray-700'
                    }`}
                  >
                    <div className="flex items-center">
                      <input
                        type="radio"
                        readOnly
                        checked={audience === 'select'}
                        className="mr-3"
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                      <span>{intl.formatMessage(messages.selectUsers)}</span>
                      {audience === 'select' && selectedUserIds.length > 0 && (
                        <Badge className="ml-2" badgeType="primary">
                          {selectedUserIds.length}
                        </Badge>
                      )}
                    </div>
                  </button>
                </div>

                {audience === 'select' && (
                  <div className="mt-4 rounded-md border border-gray-700 bg-gray-800/50">
                    <div className="flex items-center justify-between border-b border-gray-700 px-4 py-2">
                      <span className="text-sm text-gray-300">
                        {selectedUserIds.length} / {allUsers.length}
                      </span>
                      <div className="flex space-x-2">
                        <button
                          type="button"
                          onClick={selectAllUsers}
                          className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
                        >
                          {intl.formatMessage(messages.selectAll)}
                        </button>
                        <span className="text-xs text-gray-600">|</span>
                        <button
                          type="button"
                          onClick={clearSelection}
                          className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
                        >
                          {intl.formatMessage(messages.clearAll)}
                        </button>
                      </div>
                    </div>
                    {allUsers.length === 0 ? (
                      <div className="px-4 py-6 text-center text-sm text-gray-400">
                        {intl.formatMessage(messages.noUsers)}
                      </div>
                    ) : (
                      <ul className="max-h-80 divide-y divide-gray-700 overflow-y-auto">
                        {allUsers.map((user) => {
                          const isSelected = selectedUserIds.includes(user.id);
                          const isOwner = user.id === 1;
                          const isAdmin = hasPermission(
                            Permission.ADMIN,
                            user.permissions
                          );
                          const isCurrent = user.id === currentUser?.id;
                          return (
                            <li key={user.id}>
                              <label
                                htmlFor={`broadcast-user-${user.id}`}
                                className={`flex cursor-pointer items-center px-4 py-2 transition duration-150 ${
                                  isSelected
                                    ? 'bg-indigo-600/20'
                                    : 'hover:bg-gray-700/50'
                                }`}
                              >
                                <input
                                  id={`broadcast-user-${user.id}`}
                                  type="checkbox"
                                  className="mr-3"
                                  checked={isSelected}
                                  onChange={() => toggleUser(user.id)}
                                />
                                <CachedImage
                                  type="avatar"
                                  className="h-8 w-8 flex-shrink-0 rounded-full object-cover"
                                  src={user.avatar}
                                  alt=""
                                  width={32}
                                  height={32}
                                />
                                <div className="ml-3 min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-white">
                                    {user.displayName}
                                    {isCurrent && (
                                      <span className="ml-2 text-xs text-gray-400">
                                        (you)
                                      </span>
                                    )}
                                  </div>
                                  {user.email &&
                                    user.email.toLowerCase() !==
                                      user.displayName.toLowerCase() && (
                                      <div className="truncate text-xs text-gray-400">
                                        {user.email}
                                      </div>
                                    )}
                                </div>
                                {(isOwner || isAdmin) && (
                                  <Badge
                                    badgeType={isOwner ? 'warning' : 'primary'}
                                    className="ml-2"
                                  >
                                    {intl.formatMessage(
                                      isOwner ? messages.owner : messages.admin
                                    )}
                                  </Badge>
                                )}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {audience === 'select' && selectedUserIds.length === 0 && (
                  <div className="mt-2">
                    <Alert
                      type="warning"
                      title={intl.formatMessage(messages.validationRecipients)}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="actions">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <Button
                  buttonType="ghost"
                  type="button"
                  onClick={() => setOverrideOpen(true)}
                  disabled={overrideMonitors.length === 0}
                  data-testid="broadcast-open-override"
                >
                  <AdjustmentsHorizontalIcon />
                  <span>{intl.formatMessage(messages.overrideStatus)}</span>
                </Button>
                <span className="inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={
                      isSubmitting ||
                      !isValid ||
                      (audience === 'select' && selectedUserIds.length === 0)
                    }
                    data-testid="broadcast-send"
                  >
                    <MegaphoneIcon />
                    <span>
                      {isSubmitting
                        ? intl.formatMessage(messages.sending)
                        : intl.formatMessage(messages.send)}
                    </span>
                  </Button>
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {intl.formatMessage(messages.overrideStatusTip)}
              </p>
            </div>
          </Form>
        )}
      </Formik>

      <MonitorOverrideModal
        isOpen={overrideOpen}
        presetMonitor={null}
        monitors={overrideMonitors}
        onClose={() => setOverrideOpen(false)}
        onApplied={() => revalidateStatus()}
      />
    </>
  );
};

export default Broadcast;
