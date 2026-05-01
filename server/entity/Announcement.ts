import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

@Entity()
export class Announcement {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public subject: string;

  @Column({ type: 'text', nullable: true })
  public message?: string | null;

  @ManyToOne(() => User, { eager: true, onDelete: 'SET NULL', nullable: true })
  public postedBy?: User | null;

  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  @Index()
  public postedAt: Date;

  constructor(init?: Partial<Announcement>) {
    Object.assign(this, init);
  }
}
