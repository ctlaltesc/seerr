import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-aria';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.SettingsStatus.MonitorRow',
  {
    customNamePlaceholder: 'Custom name (optional)',
    descriptionPlaceholder: 'Short description (optional)',
    defaultName: 'UptimeRobot name: {name}',
    drag: 'Drag to reorder',
    hideUrl: 'Hide URL on status page',
    hidden: 'Hide this monitor from the status page',
    hideFromReports: 'Hide from the “Report a problem” modal',
    useCustomName: 'Use custom name',
    forceStatus: 'Force status',
    forceStatusNone: 'No override',
    statusOperational: 'Operational',
    statusMaintenance: 'Scheduled Maintenance',
    statusDegraded: 'Degraded Performance',
    statusPartialOutage: 'Partial Outage',
    statusMajorOutage: 'Major Outage',
    minutesLabel: 'for',
    minutesUnit: 'min',
    activeUntil: 'Active until {time}',
    clearOverride: 'Clear',
  }
);

const Position = {
  None: 'None',
  Above: 'Above',
  Below: 'Below',
} as const;

export type ManualStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

export interface MonitorRowItem {
  id: number;
  defaultName: string;
  url: string;
  status: number | string;
  name: string;
  description: string;
  hideUrl: boolean;
  hidden: boolean;
  hideFromReports: boolean;
  manualStatus?: ManualStatus;
  manualStatusUntil?: number;
}

interface MonitorRowProps {
  monitor: MonitorRowItem;
  onNameChange: (id: number, name: string) => void;
  onDescriptionChange: (id: number, description: string) => void;
  onHideUrlChange: (id: number, hideUrl: boolean) => void;
  onHiddenChange: (id: number, hidden: boolean) => void;
  onHideFromReportsChange: (id: number, hideFromReports: boolean) => void;
  onManualStatusChange: (
    id: number,
    status: ManualStatus | undefined,
    minutes: number
  ) => void;
  onMove: (
    draggedId: number,
    targetId: number,
    position: 'Above' | 'Below'
  ) => void;
}

const MonitorRow = ({
  monitor,
  onNameChange,
  onDescriptionChange,
  onHideUrlChange,
  onHiddenChange,
  onHideFromReportsChange,
  onManualStatusChange,
  onMove,
}: MonitorRowProps) => {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const [hoverPosition, setHoverPosition] = useState<keyof typeof Position>(
    Position.None
  );
  const [useCustomName, setUseCustomName] = useState<boolean>(
    !!monitor.name?.trim()
  );

  // Default the duration field to whatever's still live, falling back to 30.
  const remainingMinutes =
    monitor.manualStatusUntil && monitor.manualStatusUntil > Date.now()
      ? Math.max(
          1,
          Math.round((monitor.manualStatusUntil - Date.now()) / 60000)
        )
      : 30;
  const [minutes, setMinutes] = useState<number>(remainingMinutes);

  // If the parent reloads with a different override, reflect that in the
  // local checkbox state once.
  useEffect(() => {
    setUseCustomName((current) => current || !!monitor.name?.trim());
  }, [monitor.name]);

  const { dragProps, isDragging } = useDrag({
    getItems() {
      return [
        { id: monitor.id.toString(), 'monitor-id': monitor.id.toString() },
      ];
    },
  });

  const { dropProps } = useDrop({
    ref,
    onDropMove: (e) => {
      if (ref.current) {
        const middle = ref.current.offsetHeight / 2;
        setHoverPosition(e.y < middle ? Position.Above : Position.Below);
      }
    },
    onDropExit: () => setHoverPosition(Position.None),
    onDrop: async (e) => {
      const items = await Promise.all(
        e.items
          .filter(
            (item) => item.kind === 'text' && item.types.has('monitor-id')
          )
          .map((item) =>
            item.kind === 'text' ? item.getText('monitor-id') : undefined
          )
      );
      const droppedId = Number(items[0]);
      if (
        Number.isFinite(droppedId) &&
        droppedId !== monitor.id &&
        hoverPosition !== Position.None
      ) {
        onMove(droppedId, monitor.id, hoverPosition);
      }
      setHoverPosition(Position.None);
    },
  });

  const statusBadge = (() => {
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
      return { type: 'success' as const, label: 'Up' };
    if (raw === 'down' || raw === 'seems_down')
      return { type: 'danger' as const, label: 'Down' };
    if (raw === 'paused') return { type: 'warning' as const, label: 'Paused' };
    return { type: 'default' as const, label: 'Unknown' };
  })();

  const manualActive =
    !!monitor.manualStatus &&
    !!monitor.manualStatusUntil &&
    monitor.manualStatusUntil > Date.now();

  return (
    <div
      ref={ref}
      {...dropProps}
      data-testid={`monitor-row-${monitor.id}`}
      className={`relative rounded-md border border-gray-700 bg-gray-800/60 p-3 transition ${
        isDragging ? 'opacity-30' : 'opacity-100'
      }`}
    >
      {hoverPosition === Position.Above && (
        <div className="pointer-events-none absolute -top-1 left-0 right-0 h-1 rounded-full bg-indigo-500" />
      )}
      {hoverPosition === Position.Below && (
        <div className="pointer-events-none absolute -bottom-1 left-0 right-0 h-1 rounded-full bg-indigo-500" />
      )}
      <div className="flex items-start gap-3">
        <button
          type="button"
          {...dragProps}
          className="mt-1 cursor-grab text-gray-500 transition hover:text-gray-200 active:cursor-grabbing"
          aria-label={intl.formatMessage(messages.drag)}
          title={intl.formatMessage(messages.drag)}
        >
          <Bars3Icon className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-3">
                <span className="truncate text-sm font-semibold text-white">
                  {monitor.defaultName}
                </span>
                <label className="flex flex-shrink-0 items-center gap-2 text-xs text-gray-300">
                  <input
                    type="checkbox"
                    className="!h-4 !w-4 !rounded"
                    checked={useCustomName}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setUseCustomName(next);
                      if (!next && monitor.name) {
                        onNameChange(monitor.id, '');
                      }
                    }}
                  />
                  <span>{intl.formatMessage(messages.useCustomName)}</span>
                </label>
              </div>
              {useCustomName && (
                <input
                  type="text"
                  value={monitor.name}
                  onChange={(e) => onNameChange(monitor.id, e.target.value)}
                  placeholder={intl.formatMessage(
                    messages.customNamePlaceholder
                  )}
                  maxLength={80}
                  className="w-full"
                  aria-label={intl.formatMessage(
                    messages.customNamePlaceholder
                  )}
                />
              )}
              <p className="truncate text-xs text-gray-500">
                {intl.formatMessage(messages.defaultName, {
                  name: monitor.defaultName,
                })}
              </p>
            </div>
            <Badge badgeType={statusBadge.type} className="self-start">
              {statusBadge.label}
            </Badge>
          </div>
          <div>
            <input
              type="text"
              value={monitor.description}
              onChange={(e) => onDescriptionChange(monitor.id, e.target.value)}
              placeholder={intl.formatMessage(messages.descriptionPlaceholder)}
              maxLength={240}
              className="w-full"
              aria-label={intl.formatMessage(messages.descriptionPlaceholder)}
            />
            {monitor.url && (
              <p className="mt-1 truncate text-xs text-gray-500">
                {monitor.url}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-gray-700/60 bg-gray-900/40 p-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label className="text-xs uppercase tracking-wide text-gray-400">
                {intl.formatMessage(messages.forceStatus)}
              </label>
              <select
                value={monitor.manualStatus ?? ''}
                onChange={(e) => {
                  const next = (e.target.value || undefined) as
                    | ManualStatus
                    | undefined;
                  onManualStatusChange(monitor.id, next, minutes);
                }}
                className="short"
              >
                <option value="">
                  {intl.formatMessage(messages.forceStatusNone)}
                </option>
                <option value="operational">
                  {intl.formatMessage(messages.statusOperational)}
                </option>
                <option value="maintenance">
                  {intl.formatMessage(messages.statusMaintenance)}
                </option>
                <option value="degraded">
                  {intl.formatMessage(messages.statusDegraded)}
                </option>
                <option value="partial_outage">
                  {intl.formatMessage(messages.statusPartialOutage)}
                </option>
                <option value="major_outage">
                  {intl.formatMessage(messages.statusMajorOutage)}
                </option>
              </select>
              <label className="flex items-center gap-1 text-xs text-gray-300">
                <span>{intl.formatMessage(messages.minutesLabel)}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  value={minutes}
                  onChange={(e) => {
                    const value = Math.max(
                      1,
                      Math.min(1440, Number(e.target.value) || 0)
                    );
                    setMinutes(value);
                    if (monitor.manualStatus) {
                      onManualStatusChange(
                        monitor.id,
                        monitor.manualStatus,
                        value
                      );
                    }
                  }}
                  className="short"
                />
                <span>{intl.formatMessage(messages.minutesUnit)}</span>
              </label>
              {manualActive && (
                <Button
                  buttonType="ghost"
                  buttonSize="sm"
                  type="button"
                  onClick={() =>
                    onManualStatusChange(monitor.id, undefined, minutes)
                  }
                  aria-label={intl.formatMessage(messages.clearOverride)}
                  title={intl.formatMessage(messages.clearOverride)}
                >
                  <XMarkIcon className="h-4 w-4" />
                  <span className="ml-1 hidden sm:inline">
                    {intl.formatMessage(messages.clearOverride)}
                  </span>
                </Button>
              )}
            </div>
            {manualActive && monitor.manualStatusUntil && (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.activeUntil, {
                  time: intl.formatTime(new Date(monitor.manualStatusUntil), {
                    timeStyle: 'short',
                  }),
                })}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1 text-xs text-gray-300 sm:flex-row sm:flex-wrap sm:gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="!h-4 !w-4 !rounded"
                checked={monitor.hideUrl}
                onChange={(e) => onHideUrlChange(monitor.id, e.target.checked)}
              />
              <span>{intl.formatMessage(messages.hideUrl)}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="!h-4 !w-4 !rounded"
                checked={monitor.hidden}
                onChange={(e) => onHiddenChange(monitor.id, e.target.checked)}
              />
              <span>{intl.formatMessage(messages.hidden)}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="!h-4 !w-4 !rounded"
                checked={monitor.hideFromReports}
                onChange={(e) =>
                  onHideFromReportsChange(monitor.id, e.target.checked)
                }
              />
              <span>{intl.formatMessage(messages.hideFromReports)}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MonitorRow;
