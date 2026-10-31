'use client';
import dynamic from 'next/dynamic';
import type { AnalyticsSnapshot } from '../../analytics/model';
const Dashboard = dynamic(() => import('./dashboard'), { loading: () => <p role="status">Loading accounting dashboard...</p> });
export function AnalyticsClient({ snapshot, aiOff }: { snapshot: AnalyticsSnapshot; aiOff: string | null }) { return <Dashboard key={snapshot.digest} snapshot={snapshot} aiOff={aiOff}/>; }
