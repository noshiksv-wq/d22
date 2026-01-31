# Security Audit Report - MVP Critical Issues

## 🔴 CRITICAL - Must Fix Before MVP

### 1. **No Rate Limiting on API Endpoints**
**Location**: All API routes (`/api/discover/chat`, `/api/discover/debug`, `/api/discover/test`, `/api/discover/eval`)

**Issue**: 
- No rate limiting implemented
- Attackers can spam endpoints causing:
  - OpenAI API cost exhaustion
  - Database resource exhaustion
  - Denial of Service (DoS)

**Risk**: HIGH - Can lead to significant financial loss and service unavailability

**Fix Required**:
```typescript
// Add rate limiting middleware or use Vercel Edge Config
// Example: Limit to 10 requests per minute per IP
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 m"),
});
```

---

### 2. **No Input Validation on Request Body Size**
**Location**: `app/api/discover/chat/route.ts:2102`

**Issue**:
- `await request.json()` called without size limits
- Attackers can send massive payloads causing:
  - Memory exhaustion
  - Server crashes
  - DoS attacks

**Risk**: HIGH - Can crash the server

**Fix Required**:
```typescript
// Add body size validation
const MAX_BODY_SIZE = 100 * 1024; // 100KB
const contentLength = request.headers.get("content-length");
if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
  return NextResponse.json({ error: "Request body too large" }, { status: 413 });
}

// Or use Next.js built-in body size limit in next.config.js
```

---

### 3. **No Validation on Messages Array Length**
**Location**: `app/api/discover/chat/route.ts:2125`

**Issue**:
- Messages array can be arbitrarily large
- No limit on conversation history length
- Can cause memory issues and slow processing

**Risk**: MEDIUM - Can degrade performance and cause memory issues

**Fix Required**:
```typescript
// Add message array size validation
const MAX_MESSAGES = 50;
if (messages.length > MAX_MESSAGES) {
  return NextResponse.json(
    buildSafeResponse(
      { role: "assistant", content: "Too many messages. Please start a new conversation.", restaurants: [], followupChips: [] },
      { mode: "discovery" },
      "error:tooManyMessages"
    ),
    { status: 400 }
  );
}
```

---

### 4. **No UUID Validation on restaurantId**
**Location**: `app/api/discover/chat/route.ts:1966`, `2112`

**Issue**:
- `restaurantId` and `targetRestaurantId` used directly without validation
- Can lead to:
  - SQL injection (if used in raw queries)
  - NoSQL injection
  - Invalid UUID format errors

**Risk**: MEDIUM - Can cause errors and potential injection

**Fix Required**:
```typescript
// Add UUID validation helper
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Validate before use
if (body.targetRestaurantId && !isValidUUID(body.targetRestaurantId)) {
  return NextResponse.json({ error: "Invalid restaurant ID format" }, { status: 400 });
}
```

---

### 5. **No Input Sanitization on User Query**
**Location**: `app/api/discover/chat/route.ts:2153`

**Issue**:
- User query (`lastUserMessage.content`) used directly
- Only basic `.trim()` and punctuation removal
- No protection against:
  - Extremely long strings
  - Special characters that might break LLM prompts
  - Injection attempts

**Risk**: MEDIUM - Can cause prompt injection or errors

**Fix Required**:
```typescript
// Add query length and sanitization
const MAX_QUERY_LENGTH = 500;
if (query.length > MAX_QUERY_LENGTH) {
  query = query.substring(0, MAX_QUERY_LENGTH);
}

// Remove potentially dangerous characters
query = query.replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
```

---

### 6. **Debug/Test Endpoints Exposed in Production**
**Location**: `app/api/discover/debug/route.ts`, `app/api/discover/test/route.ts`, `app/api/discover/eval/route.ts`

**Issue**:
- Debug/test endpoints accessible without authentication
- Can be used to:
  - Exhaust OpenAI API credits
  - Overload database
  - Expose internal logic

**Risk**: HIGH - Can cause financial loss and expose system internals

**Fix Required**:
```typescript
// Option 1: Disable in production
if (process.env.NODE_ENV === 'production') {
  return NextResponse.json({ error: "Not available in production" }, { status: 404 });
}

// Option 2: Add authentication/API key
const API_KEY = process.env.DEBUG_API_KEY;
const providedKey = request.headers.get("x-api-key");
if (API_KEY && providedKey !== API_KEY) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

---

### 7. **Error Messages Leak Internal Information**
**Location**: Multiple locations in `app/api/discover/chat/route.ts`

**Issue**:
- Error messages expose:
  - Environment variable names
  - Internal file paths (`.env.local`)
  - Stack traces (if not caught)
  - Database structure hints

**Risk**: MEDIUM - Information disclosure

**Fix Required**:
```typescript
// Sanitize error messages
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // In production, return generic message
    if (process.env.NODE_ENV === 'production') {
      return "An error occurred. Please try again.";
    }
    return error.message; // Only in development
  }
  return "An unexpected error occurred.";
}
```

---

### 8. **No Request Timeout Protection**
**Location**: All API routes

**Issue**:
- Long-running requests can hang indefinitely
- No timeout protection
- Can exhaust server resources

**Risk**: MEDIUM - Resource exhaustion

**Fix Required**:
```typescript
// Add timeout wrapper
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}
```

---

### 9. **No CORS Configuration**
**Location**: All API routes

**Issue**:
- No explicit CORS headers
- Default Next.js behavior may allow all origins
- Can enable CSRF attacks

**Risk**: MEDIUM - CSRF vulnerability

**Fix Required**:
```typescript
// Add CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Or use Next.js middleware for CORS
```

---

### 10. **Offset Parameter Not Validated**
**Location**: `app/api/discover/chat/route.ts:2113`

**Issue**:
- `offset` can be negative or extremely large
- Can cause:
  - Database errors
  - Performance issues
  - Memory issues

**Risk**: LOW-MEDIUM - Can cause errors

**Fix Required**:
```typescript
// Validate offset
const offset = Math.max(0, Math.min(Number(body.offset) || 0, 1000)); // Max 1000
```

---

## 🟡 MEDIUM PRIORITY - Should Fix Soon

### 11. **No Content Security Policy (CSP)**
**Location**: Frontend pages

**Issue**: No CSP headers to prevent XSS attacks

**Fix**: Add CSP headers in `next.config.js` or middleware

---

### 12. **OpenAI API Key Exposed in Error Messages**
**Location**: `lib/intent-parser.ts:18`

**Issue**: Error message mentions `OPENAI_API_KEY` variable name (though not the value)

**Fix**: Use generic error messages

---

### 13. **No Request ID for Logging/Tracking**
**Location**: All API routes

**Issue**: Hard to track and audit requests

**Fix**: Add request ID to all requests for logging

---

## ✅ GOOD SECURITY PRACTICES FOUND

1. ✅ Using Supabase RLS (Row Level Security) policies
2. ✅ Using parameterized queries (via Supabase client)
3. ✅ Service role key kept server-side only
4. ✅ No `dangerouslySetInnerHTML` found
5. ✅ No `eval()` or `Function()` calls found
6. ✅ Environment variables properly used (not hardcoded)

---

## 📋 RECOMMENDED ACTION PLAN

### Immediate (Before MVP):
1. Add rate limiting to all API endpoints
2. Add request body size limits
3. Disable or protect debug/test endpoints in production
4. Add UUID validation for all ID parameters
5. Add input length limits on queries and messages

### Short-term (Post-MVP):
6. Add CORS configuration
7. Sanitize error messages
8. Add request timeouts
9. Add CSP headers
10. Implement request ID tracking

---

## 🔧 QUICK FIXES SUMMARY

1. **Rate Limiting**: Use Vercel Edge Config or Upstash Redis
2. **Body Size**: Add `bodyParser` config in `next.config.js`
3. **Debug Endpoints**: Add `NODE_ENV` check or API key auth
4. **UUID Validation**: Add regex validation helper
5. **Input Limits**: Add MAX constants and validation

