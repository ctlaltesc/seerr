import Broadcast from '@app/components/Broadcast';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BroadcastPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <Broadcast />;
};

export default BroadcastPage;
