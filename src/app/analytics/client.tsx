'use client';
import dynamic from 'next/dynamic';
import type { AnalyticsSnapshot } from '../../analytics/model';
const Dashboard = dynamic(() => import('./dashboard'), { loading: () => <p role="status">Loading accounting dashboard...</p> });
export function AnalyticsClient({ snapshot }: { snapshot: AnalyticsSnapshot }) { return <Dashboard key={snapshot.digest} snapshot={snapshot}/>; }
