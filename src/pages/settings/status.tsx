import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsStatus from '@app/components/Settings/SettingsStatus';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsStatusPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsStatus />
    </SettingsLayout>
  );
};

export default SettingsStatusPage;
