import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import gravatarUrl from 'gravatar-url';

export interface SeedDbOptions {
  /** If true, preserves existing data instead of dropping the database */
  preserveDb?: boolean;
  /** If true, runs migrations instead of synchronizing schema */
  withMigrations?: boolean;
}

// Precomputed bcrypt hash of 'test1234'. We precompute this to avoid
// having to hash the password every time we seed the database.
const TEST_USER_PASSWORD_HASH =
  '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';

/**
 * Seeds test users into the database.
 * Assumes the database schema is already set up.
 */
async function seedTestUsers(): Promise<void> {
  const userRepository = getRepository(User);

  const admin = await userRepository.findOne({
    select: { id: true, plexId: true },
    where: { id: 1 },
  });

  // Create the admin user
  const user =
    (await userRepository.findOne({
      where: { email: 'admin@seerr.dev' },
    })) ?? new User();
  user.plexId = admin?.plexId ?? 1;
  user.plexToken = '1234';
  user.plexUsername = 'admin';
  user.username = 'admin';
  user.email = 'admin@seerr.dev';
  user.userType = UserType.PLEX;
  user.password = TEST_USER_PASSWORD_HASH;
  user.permissions = 2;
  user.avatar = gravatarUrl('admin@seerr.dev', { default: 'mm', size: 200 });
  await userRepository.save(user);

  // Create the other user
  const otherUser =
    (await userRepository.findOne({
      where: { email: 'friend@seerr.dev' },
    })) ?? new User();
  otherUser.plexId = admin?.plexId ?? 1;
  otherUser.plexToken = '1234';
  otherUser.plexUsername = 'friend';
  otherUser.username = 'friend';
  otherUser.email = 'friend@seerr.dev';
  otherUser.userType = UserType.PLEX;
  otherUser.password = TEST_USER_PASSWORD_HASH;
  // 32 = REQUEST, 1 = STATUS_VIEW, 536870912 = STATUS_REPORT.
  // Mirrors the new default permissions for fresh users.
  otherUser.permissions = 32 | 1 | 536870912;
  otherUser.avatar = gravatarUrl('friend@seerr.dev', {
    default: 'mm',
    size: 200,
  });
  await userRepository.save(otherUser);

  // A user with absolutely no granted permissions, used by tests that
  // exercise permission gating (status-page view + report).
  const limited =
    (await userRepository.findOne({
      where: { email: 'limited@seerr.dev' },
    })) ?? new User();
  limited.plexId = admin?.plexId ?? 1;
  limited.plexToken = '1234';
  limited.plexUsername = 'limited';
  limited.username = 'limited';
  limited.email = 'limited@seerr.dev';
  limited.userType = UserType.PLEX;
  limited.password = TEST_USER_PASSWORD_HASH;
  limited.permissions = 0;
  limited.avatar = gravatarUrl('limited@seerr.dev', {
    default: 'mm',
    size: 200,
  });
  await userRepository.save(limited);
}

/**
 * Initializes the database connection and seeds test users.
 * Used by both Cypress tests and Vitest unit tests.
 */
export async function seedTestDb(options: SeedDbOptions = {}): Promise<void> {
  const dbConnection = dataSource.isInitialized
    ? dataSource
    : await dataSource.initialize();

  if (!options.preserveDb) {
    await dbConnection.dropDatabase();
  }

  if (options.withMigrations) {
    await dbConnection.runMigrations();
  } else {
    await dbConnection.synchronize();
  }

  await seedTestUsers();
}

/**
 * Resets the database to a clean state with seeded test users.
 * Used between tests to ensure isolation.
 * Assumes DB has been initialized.
 */
export async function resetTestDb(): Promise<void> {
  await dataSource.synchronize(true);
  await seedTestUsers();
}
