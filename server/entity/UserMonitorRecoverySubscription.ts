import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from './User';

@Entity()
@Unique(['user', 'monitorId'])
export class UserMonitorRecoverySubscription {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public user: User;

  @Column({ type: 'integer' })
  public monitorId: number;

  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: true,
  })
  public createdAt: Date;

  constructor(init?: Partial<UserMonitorRecoverySubscription>) {
    Object.assign(this, init);
  }
}
