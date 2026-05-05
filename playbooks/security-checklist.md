# Security Checklist

A structured security review checklist for web applications. Walk through each section from the browser to the database.

## Trust Boundary Map

Before reviewing code, draw the trust boundary:

```
Browser → Frontend Server/Proxy → Backend API → Database / Cache / Workers
          │                        │
          └─ Static assets         └─ External services (OAuth, email, payment)
```

At each boundary, ask:
- Who is authenticated here?
- What authorization checks happen here?
- What data crosses this boundary?
- What validation happens before crossing?

---

## Frontend Security

### Auth and Session
- [ ] Authentication tokens stored in httpOnly cookies (not localStorage)
- [ ] Token refresh handled automatically (not manual user action)
- [ ] Auth redirects use `router.replace` (not `push`) to prevent back-button loops
- [ ] Logout clears all client-side state and tokens

### API Proxy/Gateway
- [ ] API proxy has an allowlist of backend endpoints (not open proxy)
- [ ] Proxy strips or sanitizes request headers before forwarding
- [ ] Error responses from proxy don't leak backend details

### Client-Side Gates
- [ ] Admin/role gates exist in the layout/routing layer
- [ ] **Every client-side gate has a matching backend permission check** (client gates are UX, not security)
- [ ] Role/enum values used in frontend match backend exactly

### Input Handling
- [ ] User input is sanitized before rendering (XSS prevention)
- [ ] URLs constructed from user input are validated
- [ ] File uploads have type/size validation on both client and server

---

## Backend Security

### Authentication
- [ ] OAuth/SSO domain restrictions enforced in production
- [ ] Password hashing uses strong algorithm (bcrypt, argon2)
- [ ] JWT tokens have reasonable expiry (access: minutes, refresh: days)
- [ ] Token validation checks signature, expiry, and issuer

### Authorization
- [ ] Permission checks on every endpoint (not just some)
- [ ] Role/permission checks use backend group/role data (not request headers)
- [ ] Scoping: users can only access their own data (unless explicitly admin)
- [ ] Bulk endpoints verify permissions for each item, not just the first

### Anonymous Endpoints
- [ ] Login/register/password-reset have rate limiting
- [ ] OAuth callbacks validate state parameter
- [ ] Public API endpoints are intentionally public (not accidentally missing auth)

### Data Protection
- [ ] Sensitive fields excluded from API responses (password hashes, tokens, internal IDs)
- [ ] SQL injection prevented (parameterized queries, ORM)
- [ ] File upload paths validated (no directory traversal)
- [ ] CSV/export data sanitized for formula injection

### Configuration
- [ ] Debug mode disabled in production
- [ ] CORS restricted to known origins (not `*`)
- [ ] HTTPS enforced with HSTS headers
- [ ] Cookies set with `Secure`, `HttpOnly`, `SameSite` flags
- [ ] Secret keys/API keys not in source control
- [ ] Error responses don't include stack traces in production
