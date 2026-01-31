import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    const { restaurant_id, name, email } = body;
    if (!restaurant_id || !name || !email) {
      return NextResponse.json(
        { error: "Missing required fields: restaurant_id, name, email" },
        { status: 400 }
      );
    }

    // Get B2B base URL from environment
    const b2bBaseUrl = process.env.B2B_BASE_URL;
    if (!b2bBaseUrl) {
      console.error("[api/claim/request] B2B_BASE_URL not configured");
      return NextResponse.json(
        { error: "Claim service not configured" },
        { status: 503 }
      );
    }

    // Forward request to B2B backend
    const b2bResponse = await fetch(`${b2bBaseUrl}/api/claim/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        restaurant_id,
        name,
        email,
        phone: body.phone || null,
        message: body.message || null,
        source: "discovery-app", // Track where the claim came from
      }),
    });

    const responseData = await b2bResponse.json();

    if (!b2bResponse.ok) {
      console.error("[api/claim/request] B2B error:", responseData);
      return NextResponse.json(
        { error: responseData.error || responseData.message || "Failed to submit claim request" },
        { status: b2bResponse.status }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Claim request submitted successfully",
      ...responseData,
    });
  } catch (error) {
    console.error("[api/claim/request] Unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
