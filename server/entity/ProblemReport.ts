import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

/**
 * One row per (user, monitor) report submitted via the public status page.
 * The monitor name and observed status are snapshotted so the report stays
 * meaningful even if the monitor is later renamed, hidden, or removed.
 */
@Entity()
export class ProblemReport {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @Index()
  public reporter: User;

  @Column({ type: 'integer' })
  @Index()
  public monitorId: number;

  /** Snapshot of the friendly name shown on the status page at report time. */
  @Column()
  public monitorNameSnapshot: string;

  /** 'up' | 'down' | 'paused' | 'unknown' — the observed status at submission. */
  @Column()
  public monitorStatusAtReport: string;

  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  @Index()
  public reportedAt: Date;

  /** Set when an admin marks resolved or the auto-cleanup catches it. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  constructor(init?: Partial<ProblemReport>) {
    Object.assign(this, init);
  }
}
