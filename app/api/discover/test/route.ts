import { NextRequest, NextResponse } from "next/server";
import { searchRestaurantsAndDishes } from "@/app/actions/discover";
import { parseUserIntent } from "@/lib/intent-parser";

interface LogEntry {
  type: 'log' | 'error';
  args: unknown[];
}

/**
 * Test endpoint that shows detailed search process
 * Usage: GET /api/discover/test?q=butter+naan
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q") || "butter naan";
  
  // Capture console.log by overriding temporarily
  const originalLog = console.log;
  const originalError = console.error;
  
  const capturedLogs: LogEntry[] = [];
  console.log = (...args: unknown[]) => {
    capturedLogs.push({ type: 'log', args });
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    capturedLogs.push({ type: 'error', args });
    originalError(...args);
  };

  try {
    // Parse intent from query
    const intent = await parseUserIntent(query);
    const results = await searchRestaurantsAndDishes(intent);
    
    // Restore console
    console.log = originalLog;
    console.error = originalError;
    
    return NextResponse.json({
      query,
      resultsCount: results.length,
      results: results.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        cuisine_type: r.cuisine_type,
        highlight: r.highlight,
        address: r.address,
      })),
      logs: capturedLogs.map(log => ({
        type: log.type,
        message: log.args.map((a: unknown) => 
          typeof a === 'string' ? a : JSON.stringify(a, null, 2)
        ).join(' ')
      })),
    });
  } catch (error) {
    // Restore console
    console.log = originalLog;
    console.error = originalError;
    
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        query,
        logs: capturedLogs.map(log => ({
          type: log.type,
          message: log.args.map((a: unknown) => 
            typeof a === 'string' ? a : JSON.stringify(a, null, 2)
          ).join(' ')
        })),
      },
      { status: 500 }
    );
  }
}

