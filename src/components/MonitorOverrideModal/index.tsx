import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

const messages = defineMessages('components.MonitorOverrideModal', {
  title: 'Override status',
  description:
    'Pin {name} to a fixed status for the next few minutes. Auto-clears once the duration elapses.',
  pickerLabel: 'Service',
  pickerPlaceholder: 'Select a service',
  statusLabel: 'Status',
  minutesLabel: 'Duration (minutes)',
  none: 'Automatic',
  manualOperational: 'Operational',
  manualMaintenance: 'Scheduled Maintenance',
  manualDegraded: 'Degraded Performance',
  manualPartialOutage: 'Partial Outage',
  manualMajorOutage: 'Major Outage',
  submit: 'Apply override',
  submitting: 'Applying…',
  clear: 'Clear override',
  selectFirst: 'Pick a service first.',
  successApplied: 'Status override applied.',
  successCleared: 'Status override cleared.',
  failed: 'Could not apply the status override.',
});

export type ManualStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

export interface MonitorOption {
  id: number;
  name: string;
  manualStatus?: ManualStatus;
  manualStatusUntil?: number;
}

interface MonitorOverrideModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean;
  /**
   * When provided, this service is pre-selected on open. Pass `null` to
   * start the modal with the picker unset (admin chooses a service inside
   * the modal — used by the Broadcast page).
   */
  presetMonitor?: MonitorOption | null;
  /** Full list of available monitors for the picker. */
  monitors: MonitorOption[];
  onClose: () => void;
  onApplied: () => void;
}

const MonitorOverrideModal = ({
  isOpen,
  presetMonitor,
  monitors,
  onClose,
  onApplied,
}: MonitorOverrideModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState<ManualStatus | ''>('');
  const [minutes, setMinutes] = useState<number>(60);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the local form state every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    if (!presetMonitor) {
      setSelectedId(null);
      setStatus('');
      setMinutes(60);
      return;
    }
    setSelectedId(presetMonitor.id);
    setStatus(presetMonitor.manualStatus ?? '');
    if (
      presetMonitor.manualStatusUntil &&
      presetMonitor.manualStatusUntil > Date.now()
    ) {
      setMinutes(
        Math.max(
          1,
          Math.round((presetMonitor.manualStatusUntil - Date.now()) / 60000)
        )
      );
    } else {
      setMinutes(60);
    }
  }, [isOpen, presetMonitor]);

  const selected = monitors.find((m) => m.id === selectedId) ?? null;

  const apply = async (clear: boolean) => {
    if (!selectedId) {
      addToast(intl.formatMessage(messages.selectFirst), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }
    setSubmitting(true);
    try {
      await axios.post('/api/v1/uptimerobot/override', {
        monitorId: selectedId,
        status: clear ? null : status || null,
        minutes,
      });
      addToast(
        intl.formatMessage(
          clear || !status ? messages.successCleared : messages.successApplied
        ),
        { appearance: 'success', autoDismiss: true }
      );
      onApplied();
      onClose();
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Transition
      as="div"
      show={isOpen}
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.title)}
        onCancel={onClose}
        onOk={() => apply(false)}
        okText={
          submitting
            ? intl.formatMessage(messages.submitting)
            : intl.formatMessage(messages.submit)
        }
        okButtonType="primary"
        okDisabled={submitting || !selectedId}
        onSecondary={() => apply(true)}
        secondaryText={intl.formatMessage(messages.clear)}
        secondaryButtonType="warning"
        secondaryDisabled={submitting || !selected?.manualStatus}
      >
        {selected && (
          <p className="mb-4 text-sm text-gray-300">
            {intl.formatMessage(messages.description, {
              name: selected.name,
            })}
          </p>
        )}
        <div className="form-row">
          <label htmlFor="overrideMonitor" className="text-label">
            {intl.formatMessage(messages.pickerLabel)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <select
                id="overrideMonitor"
                value={selectedId ?? ''}
                onChange={(e) => {
                  const next = e.target.value ? Number(e.target.value) : null;
                  setSelectedId(next);
                  const m = monitors.find((mon) => mon.id === next);
                  setStatus(m?.manualStatus ?? '');
                  if (
                    m?.manualStatusUntil &&
                    m.manualStatusUntil > Date.now()
                  ) {
                    setMinutes(
                      Math.max(
                        1,
                        Math.round((m.manualStatusUntil - Date.now()) / 60000)
                      )
                    );
                  }
                }}
              >
                <option value="">
                  {intl.formatMessage(messages.pickerPlaceholder)}
                </option>
                {monitors.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="overrideStatus" className="text-label">
            {intl.formatMessage(messages.statusLabel)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <select
                id="overrideStatus"
                value={status}
                onChange={(e) =>
                  setStatus((e.target.value as ManualStatus | '') || '')
                }
              >
                <option value="">{intl.formatMessage(messages.none)}</option>
                <option value="operational">
                  {intl.formatMessage(messages.manualOperational)}
                </option>
                <option value="maintenance">
                  {intl.formatMessage(messages.manualMaintenance)}
                </option>
                <option value="degraded">
                  {intl.formatMessage(messages.manualDegraded)}
                </option>
                <option value="partial_outage">
                  {intl.formatMessage(messages.manualPartialOutage)}
                </option>
                <option value="major_outage">
                  {intl.formatMessage(messages.manualMajorOutage)}
                </option>
              </select>
            </div>
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="overrideMinutes" className="text-label">
            {intl.formatMessage(messages.minutesLabel)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <input
                id="overrideMinutes"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="short"
                value={minutes}
                onChange={(e) =>
                  setMinutes(
                    Math.max(1, Math.min(1440, Number(e.target.value) || 0))
                  )
                }
              />
            </div>
          </div>
        </div>
      </Modal>
    </Transition>
  );
};

export default MonitorOverrideModal;
