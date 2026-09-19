import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('organisation')
export class OrganisationEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
