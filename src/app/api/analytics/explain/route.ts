import { getDatabase } from '../../../../server/db';
import { handleAnalytics } from '../../../../server/analytics-actions';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleAnalytics(request, { db: getDatabase() }); }
