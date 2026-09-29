# Coverage map — Pocketful stage 1

Generated from the suite itself: `node main.mjs --coverage`. Every reference below comes
from `lib/inventory.mjs`, which was written from `spec/stage-1.md` alone. A reference with
no check is listed as a gap, and every gap must carry a reason.

| | |
|---|---|
| requirement references | 171 |
| references with at least one check | 149 |
| references deliberately left to out-of-band verification | 22 |
| references with no check and no stated reason | 0 |
| coordinator interpretations checked (advisory only) | 17 of 17 |
| checks | 207 (161 blocking, 46 advisory) |

A **blocking** check fails the suite and rejects a handoff. An **advisory** check is one
where the specification text does not settle the answer: it records what the service did
and why the question is open, and never rejects on its own. Each advisory check carries
its reasoning in the source and prints it on failure.

## Requirements to checks

### Specification 1

| ref | requirement | checks |
|---|---|---|
| R1.1 | Users can send money by handle. | 04: a payment returns the documented object and moves money |
| R1.2 | Users can request money. | 06: a request returns the documented object with the caller as requester |
| R1.3 | Users can split bills. | 08: a split returns the documented object and one request per other participant |
| R1.4 | Payments appear in an activity feed with public or private visibility. | 07: the feed shows a payment if and only if it is public or the caller is a party |
| R1.5 | Authorized operators can submit groups of transfers as settlements. | 09: a settlement returns settlement_id, committed_at and payments in input order |
| R1.6 | Only the HTTP API is required. | **not checked over HTTP** — A statement of scope, not a behaviour. The suite tests the HTTP API only, which is what it asserts. |
| R1.7 | The sum of wallet balances always equals the total seeded by the last POST /_test/reset, including under concurrent requests and retries. | 02: the sum of wallet balances equals the seeded total<br>03: a signup never mints a user id the fixture already seeded<br>04: every wallet total is preserved across a run of payments<br>05: concurrent requests with different keys each take effect once<br>06: a request lifecycle preserves the seeded total throughout<br>08: balances still sum to the seeded total after many splits are paid in full<br>09: the seeded total survives a run of settlements<br>11: no precedence question ever moves money<br>12: a sustained mixed load never breaks the seeded total or goes negative<br>12: concurrent settlements competing for the same funds stay consistent |
| R1.8 | No wallet balance may be negative, including transiently. | 04: a payment may spend the whole balance but not one unit more<br>11: no precedence question ever moves money<br>12: a sustained mixed load never breaks the seeded total or goes negative<br>12: balances sampled while money is moving are never negative<br>12: concurrent settlements competing for the same funds stay consistent |
| R1.9 | A payment request may move money at most once. | 06: a request moves money at most once<br>12: a request under concurrent payment attempts moves money once<br>12: concurrent pay, decline and cancel on one request produce one outcome |
| R1.10 | All amounts are exact integer counts of minor units. | **not checked over HTTP** — Restated with enforcement detail as R4.1, R4.2 and R4.17, which are checked. |
| R1.11 | Deposits, top-ups, withdrawals, cards and bank integrations are out of scope; money moves only between existing wallets. | **not checked over HTTP** — A statement of scope. Partially covered in substance: the suite checks that money only moves between existing wallets (unknown handle is 404 everywhere). The absence of deposit, top-up, withdrawal, card and bank endpoints is not something an acceptance suite can prove, only the absence of a documented one. |

### Specification 2

| ref | requirement | checks |
|---|---|---|
| R2.1 | An HTTP service, a Dockerfile and a RUN.md with a command that builds and starts the service without manual setup. | **not checked over HTTP** — Repository artefacts (Dockerfile, RUN.md) and the build command. Verified by inspecting the delivered tree and running the documented commands, not over HTTP. |
| R2.2 | A docker-compose.yml is optional. | **not checked over HTTP** — States that a file is optional. Nothing to check. |
| R2.3 | The submission is a containerized HTTP service, not a Python package; language, framework and storage are unrestricted. | **not checked over HTTP** — A constraint on the submission form, not on HTTP behaviour. |
| R2.4 | The image must run on its own with -e PORT=<port> and a port mapping. | **not checked over HTTP** — How the container is started (-e PORT and a port mapping). The suite is pointed at whatever BASE_URL the launcher produced, so it exercises the result but cannot itself vary PORT. Checked out of band by starting the image twice. |
| R2.5 | No outbound network at run time; all dependencies, initialization and seed data work inside the one container. | **not checked over HTTP** — Run-time network isolation. Checked out of band by starting the container with --network none; the suite is designed to pass in exactly that configuration, which is how it contributes evidence. |
| R2.6 | Resource limits: 2 vCPU, 2 GiB, 60 s to first healthy response, up to 50 requests in flight, 5 s per request (10 s for POST /_test/reset), ephemeral disk. | 02: reset stays inside the 10 second test-control budget<br>03: reset stays inside the budget even when no two seeded passwords match *(advisory)*<br>12: a sustained mixed load never breaks the seeded total or goes negative |
| R2.7 | Runtime assets and dependencies are included in the image. | **not checked over HTTP** — Image contents. Checked out of band by inspecting the built image. |

### Specification 3.1

| ref | requirement | checks |
|---|---|---|
| R3.1 | Listen on 0.0.0.0 using the PORT environment variable, default 8080. | **not checked over HTTP** — The bind address and the PORT default are properties of how the process starts. The suite proves the service answers on the URL it was given; 0.0.0.0 and the 8080 default are checked out of band. |

### Specification 3.2

| ref | requirement | checks |
|---|---|---|
| R3.2 | GET /health returns 200 {"status":"ok"} once the service and its data store can serve requests, within 60 s of container start. | 01: GET /health answers 200 with {"status":"ok"} |

### Specification 3.3

| ref | requirement | checks |
|---|---|---|
| R3.3 | POST /_test/reset replaces all state with the fixture and returns 204; afterwards only that fixture is visible; repeated resets are supported; it is enabled in the delivered image and needs no authentication. | 02: a valid fixture returns 204 and the service stays healthy<br>02: reset needs no Authorization header<br>02: after 204 only the new fixture is visible<br>02: repeated resets are supported |

### Specification 3.4

| ref | requirement | checks |
|---|---|---|
| R3.4a | Requests and responses are application/json; charset=utf-8. | 01: every response declares application/json; charset=utf-8 |
| R3.4b | Timestamps in responses are RFC 3339 with an explicit offset. | 01: timestamps are RFC 3339 with an explicit offset |
| R3.4c | Unknown fields in a request body are ignored, never an error. | 01: unknown fields in a request body are ignored, never an error<br>02: unknown top-level fixture fields are ignored<br>06: decline and cancel accept an Idempotency-Key header without requiring one *(advisory)* |
| R3.4d | Unknown query parameters are ignored. | 01: GET /health ignores unknown query parameters<br>01: unknown query parameters are ignored on list endpoints |
| R3.4e | IDs are opaque strings of at most 64 characters. | 01: ids are opaque strings of at most 64 characters<br>04: a created payment never reuses a seeded id |

### Specification 4

| ref | requirement | checks |
|---|---|---|
| R4.1 | One currency, declared in the fixture; every API amount is an integer count of its minor units. | 02: amounts stay plain integer minor units whatever minor_units says |
| R4.2 | API amounts must have an integral numeric value: 1000, 1000.0 and 1e3 are the same valid amount; booleans and strings are not numbers. | 04: 1000, 1000.0 and 1e3 are the same valid amount<br>04: an amount that is not an integral number is 422 |
| R4.3 | Every user has a handle: unique across the service, matching ^[a-z0-9_]{1,20}$, never changing once set. | 03: a signup never mints a user id the fixture already seeded<br>04: a handle differing only in case does not resolve<br>04: a syntactically impossible handle is rejected, never resolved *(advisory)* |
| R4.4 | Users identify recipients by handle; directory and user-search endpoints are out of scope. | **not checked over HTTP** — A statement of scope: there is no directory endpoint to test. Recipient identification by handle is covered throughout. |
| R4.5 | Seeded users take their handle from the fixture. | 02: seeded balances are used as given and never re-derived from seeded payments |
| R4.6 | A signed-up user has a handle derived from the email: local part, lowercased, every character outside [a-z0-9_] replaced with _, truncated to 20 characters. | 03: the handle is derived from the email exactly as spec 4 states<br>03: a non-ASCII local part is lowercased then replaced character by character *(advisory)*<br>03: derivation lowercases before replacing, even when lowercasing expands *(advisory)* |
| R4.7 | If the derived handle is already taken the signup fails. | **not checked over HTTP** — Restated with its error code as R6.7, which is checked. |
| R4.8 | New users start with a balance of 0 and can receive money and be asked for money immediately. | 03: signup returns 201 with a working token and a zero balance<br>03: a new account can receive money and be asked for money immediately |
| R4.9 | A payment moves money from one wallet to another immediately and atomically, sent directly or created by paying a request. | 04: a payment returns the documented object and moves money |
| R4.10 | A request is pending and then exactly one of paid, declined or cancelled; only the payer may pay or decline, only the requester may cancel. | 12: concurrent pay, decline and cancel on one request produce one outcome |
| R4.11 | A request may exceed the payer balance; it stays pending, paying while short is 409 insufficient_funds and changes nothing, and money arriving later makes it payable. | 06: creating a request never touches a balance<br>06: a short payer gets 409 insufficient_funds and the request stays payable |
| R4.12 | Visibility belongs to the payment, not the request; the payer chooses it when the money moves; a request carries no visibility and never appears in anyone else's feed. | 06: the payer chooses the visibility of the payment that settles a request |
| R4.13 | GET /activity returns payments only, visible if and only if the payment is public or the caller is its sender or receiver. No other rule. | 07: the feed shows a payment if and only if it is public or the caller is a party<br>07: a brand new account has an empty feed except for public payments |
| R4.14 | Requests never appear in the activity feed; GET /requests returns only requests where the caller is requester or payer. | 06: GET /requests returns only requests where the caller is requester or payer<br>06: requests never appear in the activity feed |
| R4.15 | A split is not a feed item; its requests are visible to their own two parties and the payments that fulfil them follow the feed rule. | 07: payments settling a request appear in the feed under the ordinary rule<br>08: a split is not a feed item<br>08: a split's requests are visible only to their own two parties |
| R4.16 | Visibility is one value on the payment, seen identically by both parties and by everyone else; a private payment is hidden from third parties, not from its own receiver. | 07: a private payment is visible to its own receiver and sender<br>07: a public payment is seen identically by parties and third parties |
| R4.17 | amount is at most 1000000000 on any single request; no operation produces a balance outside 2^53; monetary arithmetic is exact. | 04: the maximum single amount of 1000000000 is accepted<br>04: minor-unit arithmetic stays exact at the top of the range |
| R4.18 | The fixture format: currency, minor_units, users[], payments[], requests[] with the fields shown. | 02: seeded payments and requests are visible with their seeded values<br>02: a seeded request may arrive in a terminal status *(advisory)*<br>02: a fixture with two seeded payments sharing an id is not silently collapsed *(advisory)* |
| R4.19 | Seeded users can log in with the given password immediately. | 02: seeded users log in with the fixture password immediately |
| R4.20 | A seeded balance is the balance after every seeded payment; seeded payments are not replayed against balances. | 02: seeded balances are used as given and never re-derived from seeded payments |
| R4.21 | A balance below zero in a fixture is a reset error: 422 validation_failed, changing nothing. | 02: a fixture balance below zero is 422 validation_failed and changes nothing |
| R4.22 | minor_units is 0, 2 or 3; fixtures use EUR (2), JPY (0) and BHD (3). | 02: minor_units 0, 2 and 3 are all accepted and reported |
| R4.23 | An administrative balance endpoint is out of scope. | **not checked over HTTP** — A statement of scope: there is no administrative balance endpoint to test. |

### Specification 5

| ref | requirement | checks |
|---|---|---|
| R5.1 | Every 4xx and 5xx response carries {"error":{"code":..,"message":..}}. | 01: an unrouted path answers 4xx carrying the spec-5 error envelope<br>01: a wrong method on a known path answers 4xx with an error envelope |
| R5.2 | 400 malformed_request: an unparseable body, or a field of the wrong JSON type. | 01: an unparseable body is 400 malformed_request<br>02: a fixture field of the wrong JSON type is 400 malformed_request *(advisory)*<br>03: signup and login reject missing fields with 422 and wrong types with 400<br>04: to_handle of the wrong JSON type is 400, and absent is 422<br>08: a non-string element inside participant_handles is rejected *(advisory)*<br>11: an unparseable body beats a missing idempotency key *(advisory)*<br>11: an unparseable body beats a missing token *(advisory)* |
| R5.3 | 400 missing_idempotency_key: a required Idempotency-Key header absent or empty. | 05: an absent Idempotency-Key is 400 missing_idempotency_key |
| R5.4 | 401 unauthenticated: a missing, malformed or unknown bearer token. | 03: protected endpoints reject a missing, malformed or unknown token with 401<br>03: an idempotency key is never required before authentication is settled *(advisory)*<br>11: an unknown bearer token beats an invalid query parameter *(advisory)* |
| R5.5 | 403 forbidden: authenticated but not permitted to touch this resource. | 06: only the payer may pay; others get 403 and unknown ids get 404 |
| R5.6 | 404 not_found: no such resource, or not visible to this caller. | 01: an unrouted path answers 404 not_found *(advisory)* |
| R5.7 | 409 idempotency_key_reuse: a key already used by this caller with a different request body. | 05: the same key with a different body is 409 idempotency_key_reuse |
| R5.8 | 422 validation_failed: a required field or query parameter is missing, or a stated rule is violated with no more specific code. | 02: a fixture missing users is 422 validation_failed *(advisory)*<br>02: a structurally inconsistent fixture is rejected without changing state *(advisory)*<br>03: signup and login reject missing fields with 422 and wrong types with 400<br>04: to_handle of the wrong JSON type is 400, and absent is 422 |
| R5.9 | A field of the correct JSON type with an invalid format or out-of-range value gives 422 validation_failed unless the endpoint specifies otherwise. | 04: an amount that is not an integral number is 422 |
| R5.10 | Endpoint field rules take precedence: an invalid amount (including strings and booleans), a non-string note (including null) and any visibility other than public or private are 422; omission alone selects the optional-field default. | 04: a note of the wrong JSON type, including null, is 422 |
| R5.11 | An integer-valued query parameter is plain decimal digits: 1e9, 4.0 and +4 are 422 whatever their numeric value. | 06: limit, offset and has_more behave as specified |
| R5.12 | 400 malformed_request is reserved for a body that does not parse or a field of the wrong type. | 11: a body of the wrong JSON type beats every later check |
| R5.13 | Idempotency-Key is 1 to 255 characters, otherwise 422 validation_failed. | 05: a key of 1 and of 255 characters is accepted<br>05: a key of 256 characters is 422 validation_failed<br>11: an over-long idempotency key beats endpoint field validation *(advisory)* |
| R5.14 | limit is an integer 1 to 200, otherwise 422 validation_failed. | **not checked over HTTP** — The same rule as the limit clause of R8.25, checked there for both list endpoints. |
| R5.15 | offset is an integer 0 or more, otherwise 422 validation_failed. | **not checked over HTTP** — The same rule as the offset clause of R8.25, checked there for both list endpoints. |
| R5.16 | Requests must not produce 5xx responses, including under concurrent load. | 12: a sustained mixed load never breaks the seeded total or goes negative<br>12: reads stay coherent while writes are in flight |

### Specification 6

| ref | requirement | checks |
|---|---|---|
| R6.1 | POST /auth/signup {email,password,display_name} returns 201 {user_id, display_name, token}. | 03: signup returns 201 with a working token and a zero balance |
| R6.2 | POST /auth/login {email,password} returns 200 {user_id, display_name, token}. | 02: seeded users log in with the fixture password immediately |
| R6.3 | An already registered email is 409 email_taken. | 03: a duplicate email is 409 email_taken<br>03: a seeded email is also 409 email_taken<br>12: concurrent signups for one email create one account |
| R6.4 | A password shorter than 8 characters is 422 validation_failed. | 03: a password shorter than 8 characters is 422 |
| R6.5 | An email not of the form local@domain is 422 validation_failed. | 03: an email not of the form local@domain is 422 |
| R6.6 | A wrong password or an unknown email on login is 401 unauthenticated. | 03: a wrong password or an unknown email on login is 401 |
| R6.7 | A derived handle already taken is 409 handle_taken, and no account is created. | 03: an email deriving a taken handle is 409 handle_taken and creates no account<br>03: handle collision by truncation is 409 handle_taken<br>12: concurrent signups deriving one handle create one account |
| R6.8 | Every other endpoint requires a bearer token, except /health, /_test/reset and the two auth endpoints (and the section 10 test endpoints, which are stated unauthenticated). | 01: GET /health needs no Authorization header<br>03: protected endpoints reject a missing, malformed or unknown token with 401 |
| R6.9 | Authorization: Bearer <token>. | **not checked over HTTP** — The header form itself is exercised by every authenticated call in the suite; there is no separate check because a wrong form would fail all of them. |
| R6.10 | Tokens do not expire; an account may have multiple valid tokens and concurrent sessions. | 03: an account may hold several valid tokens at once<br>03: a signup token and a login token for the same account both work<br>03: a signup never mints a user id the fixture already seeded |
| R6.11 | Passwords are stored with bcrypt, scrypt, Argon2 or an equivalent; plaintext storage is not permitted. | 03: no plaintext password is recoverable from the exported state |
| R6.12 | Email verification, password reset, refresh tokens and role-management endpoints are out of scope. | **not checked over HTTP** — A statement of scope: there are no such endpoints to test. |

### Specification 7

| ref | requirement | checks |
|---|---|---|
| R7.1 | Five write paths require an idempotency key: POST /payments, POST /requests, POST /requests/{id}/pay, POST /splits and POST /settlements, each independently. | 05: an absent Idempotency-Key is 400 missing_idempotency_key |
| R7.2 | The key is a client-chosen string of 1 to 255 characters. | 05: a key of 1 and of 255 characters is accepted |
| R7.3 | The key is scoped to the authenticated user; two users may use the same string with no interaction. | 05: a key is scoped to the authenticated user |
| R7.4 | A replay is the same user, method, path and body; the same key and body on a different path is a different request and must succeed normally. | 05: the same key and body on a different path is a different request |
| R7.5 | Header absent or empty: 400 missing_idempotency_key. | 05: an absent Idempotency-Key is 400 missing_idempotency_key<br>05: an empty Idempotency-Key is 400 missing_idempotency_key<br>09: an operator still needs an idempotency key<br>11: a missing idempotency key beats endpoint field validation *(advisory)* |
| R7.6 | First use of the key: the normal response, 201. | 05: first use returns 201 and a replay of the same body returns 200 with the identical value |
| R7.7 | Replay with the same body: 200, with a body identical to the original response as a JSON value. | 05: first use returns 201 and a replay of the same body returns 200 with the identical value |
| R7.8 | The same key with a different body: 409 idempotency_key_reuse. | 05: the same key with a different body is 409 idempotency_key_reuse |
| R7.9 | A key reused after the original request failed with 4xx is treated as a first use. | 05: a key used by a request that failed with 4xx is free again |
| R7.10 | "Same body" means the same JSON value after parsing; key order and whitespace do not matter. | 05: a replay is recognised across key order and whitespace |
| R7.11 | For concurrent identical requests with an unused key, exactly one returns 201 and the others 200 with the same body; the operation takes effect only once. | 05: concurrent identical requests apply once: exactly one 201, the rest 200<br>05: concurrent requests with different keys each take effect once |
| R7.12 | A successful replay returns the original response even after the resource changes or is cancelled, and makes no further state changes. | 05: a successful replay still returns the original response after the resource changes |
| R7.13 | After the body has parsed as a JSON object and the caller is authenticated, an already claimed key is resolved before endpoint field validation or current-resource checks. | 05: an already claimed key resolves before endpoint field validation<br>05: an already claimed key resolves before the unknown-handle lookup<br>05: an already claimed key resolves before the current-resource check |

### Specification 8

| ref | requirement | checks |
|---|---|---|
| R8.1 | GET /me returns {user_id, display_name, handle, balance, currency, minor_units}. | 03: GET /me returns exactly the documented fields |
| R8.2 | POST /payments takes to_handle, amount, note (optional, default "") and visibility (optional, default "public"). | 04: a payment returns the documented object and moves money<br>04: note defaults to "" and visibility defaults to public |
| R8.3 | A payment is {payment_id, from_user_id, from_handle, to_user_id, to_handle, amount, currency, note, visibility, request_id, created_at}. | 04: a payment returns the documented object and moves money<br>04: a created payment never reuses a seeded id |
| R8.4 | A caller balance below amount is 409 insufficient_funds. | 04: a balance below amount is 409 insufficient_funds and moves nothing<br>04: a payment may spend the whole balance but not one unit more<br>11: an unresolvable recipient beats a balance the caller does not have |
| R8.5 | An amount below 1, above 1000000000, or not an integer is 422 validation_failed. | 04: an amount that is not an integral number is 422 |
| R8.6 | to_handle equal to the caller own handle is 422 self_payment. | 04: paying your own handle is 422 self_payment<br>04: self_payment is decided before the balance is consulted *(advisory)*<br>11: a self payment beats a balance the caller does not have *(advisory)* |
| R8.7 | A note longer than 200 characters is 422 validation_failed. | 04: a note longer than 200 characters is 422 and 200 is accepted<br>04: a 200-code-point note of astral characters is accepted *(advisory)* |
| R8.8 | A visibility other than public or private is 422 validation_failed. | 04: visibility must be public or private<br>06: an invalid visibility on the pay path is 422<br>11: an invalid visibility beats a balance the caller does not have *(advisory)* |
| R8.9 | No user with that handle is 404 not_found. | 04: an unknown handle is 404, ahead of any balance question<br>04: a syntactically impossible handle is rejected, never resolved *(advisory)*<br>11: an unresolvable recipient beats a balance the caller does not have |
| R8.10 | The debit and the credit are one atomic step; a payment is never visible in one wallet and not the other, and a failed payment leaves no trace in either. | 04: a balance below amount is 409 insufficient_funds and moves nothing<br>12: reads stay coherent while writes are in flight |
| R8.11 | A note is stored and returned verbatim: no trimming, escaping or normalisation; Unicode and emoji survive byte for byte. | 04: a note is stored and returned verbatim |
| R8.12 | POST /requests takes payer_handle, amount and note; the caller is the requester. | 06: a request returns the documented object with the caller as requester |
| R8.13 | A request is {request_id, requester_id, requester_handle, payer_id, payer_handle, amount, currency, note, status, payment_id, created_at}. | 06: a request returns the documented object with the caller as requester |
| R8.14 | Request errors: amount out of range 422; payer_handle the caller own 422 self_request; note over 200 characters 422; unknown handle 404. | 06: request errors follow the documented table |
| R8.15 | The payer balance is not checked when a request is created. | 06: creating a request never touches a balance |
| R8.16 | POST /requests/{id}/pay is the payer only; the body carries visibility only, optional, default public; a replay must send the identical body, so {} and {"visibility":"public"} are different. | 05: {} and {"visibility":"public"} are different bodies on the pay path<br>06: the payer chooses the visibility of the payment that settles a request |
| R8.17 | Pay returns 201 with the created payment exactly as POST /payments returns one, request_id set to this request; the request becomes paid and carries the new payment_id. | 06: paying a request returns a payment and marks the request paid |
| R8.18 | Pay errors: not pending 409 request_not_pending; balance below amount 409 insufficient_funds; caller not the payer 403 forbidden; unknown request 404 not_found. | 06: a short payer gets 409 insufficient_funds and the request stays payable<br>06: only the payer may pay; others get 403 and unknown ids get 404<br>11: a terminal status beats a balance the payer does not have *(advisory)*<br>11: an unknown request id beats a missing idempotency key *(advisory)* |
| R8.19 | Replaying a successful pay returns 200 with the original payment body even though the request is already paid, moves no money, and must not return 409 request_not_pending. | 05: an already claimed key resolves before the current-resource check |
| R8.20 | POST /requests/{id}/decline is the payer only, takes no idempotency key, returns 200 declined; declining twice is 200; a paid or cancelled request is 409 request_not_pending; not the payer is 403. | 06: decline is the payer only, is idempotent by itself, and moves no money<br>06: a paid request can no longer be declined or cancelled |
| R8.21 | POST /requests/{id}/cancel is the requester only, takes no idempotency key, returns 200 cancelled; cancelling twice is 200; a paid or declined request is 409 request_not_pending; not the requester is 403. | 06: cancel is the requester only, is idempotent by itself, and moves no money<br>06: a paid request can no longer be declined or cancelled |
| R8.22 | GET /requests returns requests where the caller is requester or payer and no others, newest first by created_at. | 06: GET /requests returns only requests where the caller is requester or payer<br>06: requests are ordered newest first<br>08: a split's requests are visible only to their own two parties |
| R8.23 | direction is incoming (the caller is the payer), outgoing (the caller is the requester) or absent for both. | 06: direction and status filters select exactly what they name |
| R8.24 | status is one of the four statuses, or absent for all. | 06: direction and status filters select exactly what they name |
| R8.25 | limit defaults to 50, range 1 to 200; offset defaults to 0 and must be 0 or more; outside either range is 422, as is an unknown direction or status value. | 06: an unknown direction or status value is 422<br>06: limit, offset and has_more behave as specified |
| R8.26 | has_more is true when items exist beyond the last one returned. | 06: limit, offset and has_more behave as specified<br>07: limit, offset and has_more behave as on GET /requests |
| R8.27 | GET /requests returns {"requests":[..],"has_more":bool}. | 06: GET /requests returns only requests where the caller is requester or payer |
| R8.28 | POST /splits takes amount, participant_handles and note; the caller may be included in participant_handles or omitted. | 08: a split returns the documented object and one request per other participant<br>08: note defaults to "" on a split<br>08: the caller may be omitted from participant_handles |
| R8.29 | Shares follow the section 9 rule in the order the handles are given; a request is created for every participant except the caller, each for that participant share, with the caller as requester. | 08: a split returns the documented object and one request per other participant |
| R8.30 | A split is {split_id, amount, currency, note, shares[{handle,amount}], requests[..], created_at}. | 08: a split returns the documented object and one request per other participant |
| R8.31 | shares covers every participant including the caller, in the order given, and always sums to amount; requests covers every participant except the caller, in the same order. | 08: a split returns the documented object and one request per other participant<br>08: the caller may be omitted from participant_handles |
| R8.32 | Split errors: amount out of range 422; participant_handles empty or containing a duplicate 422; note over 200 characters 422; any unknown handle 404. | 08: split errors follow the documented table |
| R8.33 | A split whose only participant is the caller is valid: one share, zero requests, "requests": []. | 08: a split whose only participant is the caller creates no requests |
| R8.34 | Nothing about a split checks anyone balance. | 08: nothing about a split checks a balance |
| R8.35 | GET /activity returns payments visible by the feed contract, newest first by created_at, as {"payments":[..],"has_more":bool}. | 07: a feed item is a full payment object<br>07: the feed is ordered newest first |
| R8.36 | The relative order of two payments created within the same second is unspecified, and stable pagination during concurrent writes is not required for GET /activity. | **not checked over HTTP** — An explicit relaxation, not a requirement. The suite relies on it: it never asserts an order between two items created in the same second, and never asserts pagination stability during concurrent writes. |
| R8.37 | limit and offset on GET /activity behave exactly as on GET /requests. | 07: limit, offset and has_more behave as on GET /requests |
| R8.38 | An item in GET /activity is a payment object of the shape in R8.3. | 07: a feed item is a full payment object |
| R8.39 | An item in GET /requests is a request object of the shape in R8.13. | 06: GET /requests returns only requests where the caller is requester or payer |

### Specification 9

| ref | requirement | checks |
|---|---|---|
| R9.1 | Shares are whole minor units, sum exactly to amount, and differ by at most one minor unit. | 08: the share table of specification 9 is reproduced exactly<br>08: shares always sum to the amount across a range of sizes |
| R9.2 | When the amount does not divide evenly the larger shares go to the first participants in participant_handles order. | 08: the share table of specification 9 is reproduced exactly<br>08: the extra unit follows participant order |
| R9.3 | The stated table: 1000/3 -> 334,333,333; 1/3 -> 1,0,0; 10/3 -> 4,3,3; 999/3 -> 333,333,333; 5/5 -> 1,1,1,1,1. | 08: the share table of specification 9 is reproduced exactly |
| R9.4 | A different participant order gives the extra unit to a different person; a share of 0 is legal and still produces a request. | 08: the extra unit follows participant order<br>08: a share of 0 is legal and still creates a request<br>08: a zero-share request can be paid *(advisory)* |
| R9.5 | Each split shares are independent of previous splits; after any number of splits have been paid in full, balances still sum exactly to the seeded total. | 08: each split computes its shares independently of previous splits<br>08: balances still sum to the seeded total after many splits are paid in full |

### Specification 10

| ref | requirement | checks |
|---|---|---|
| R10.1 | GET /_test/export and POST /_test/import exist and, like reset, are unauthenticated test endpoints. | 10: export returns track, format_version and an opaque state object |
| R10.2 | Export returns 200 with a JSON object containing track: "pocketful", format_version: 1 and state (an implementation-defined JSON object). | 10: export returns track, format_version and an opaque state object |
| R10.3 | The state format is opaque to the caller and must be accepted unchanged by import. | 10: import accepts an unchanged export and needs no bearer token |
| R10.4 | Import takes that entire object and atomically replaces the service state, returning 204. | 10: import accepts an unchanged export and needs no bearer token |
| R10.5 | Import must accept an unchanged export produced by this service. | 10: import accepts an unchanged export and needs no bearer token |
| R10.6 | No dependency on the source process, files, volume, port or network address is allowed. | 10: an export moves to another container with no dependency on the source |
| R10.7 | Import is replacement, not merge; repeating it restores the exported state without duplicating anything. | 10: import is replacement, not merge, and repeats without duplicating |
| R10.8 | Invalid JSON follows section 5; missing fields, a wrong track or version, or an invalid state give 422 validation_failed without changing the destination. | 10: an invalid import is 422 and leaves the destination untouched<br>10: a state that did not come from this service is rejected, not half applied *(advisory)* |
| R10.9 | Test control calls have a 10-second timeout. | 02: reset stays inside the 10 second test-control budget<br>03: reset stays inside the budget even when no two seeded passwords match *(advisory)*<br>10: test control endpoints answer within the 10 second budget |
| R10.10 | Export is an atomic, read-only snapshot; subsequent source writes do not change it. | 10: export is a snapshot: later writes do not change what it restores |
| R10.11 | Preserve accounts and hashed-password login, existing bearer tokens, currency, balances, payments, requests, permissions, and all completed idempotent request bodies and original responses. | 10: an unchanged export restores every observable fact about the state |
| R10.12 | Identities, timestamps and monetary records must not be regenerated or replayed against an already-net balance. | 10: an unchanged export restores every observable fact about the state |
| R10.13 | Failed request keys remain reusable. | 10: an unchanged export restores every observable fact about the state |
| R10.14 | Existing receipts, tokens and retries remain valid after import; replacing the state with a fresh fixture does not satisfy this. | 10: an unchanged export restores every observable fact about the state |
| R10.15 | Import removes all previous destination data and credentials. | 10: an unchanged export restores every observable fact about the state<br>10: import is replacement, not merge, and repeats without duplicating |
| R10.16 | Reset clears all state, including imported state. | 10: reset clears imported state |
| R10.17 | State need not survive an abrupt container restart. | **not checked over HTTP** — An explicit relaxation. The suite never restarts the container and never requires state to survive one. |
| R10.18 | Exports may contain credentials and session tokens; handle them as private test artifacts. | **not checked over HTTP** — An instruction to whoever holds an export, not a service behaviour. Honoured rather than tested: the suite never writes an export to disk and never prints one. |

### Specification 11

| ref | requirement | checks |
|---|---|---|
| R11.1 | The reset fixture may include settlement_operator_ids, an array of user ids, default []. | 02: settlement_operator_ids defaults to an empty array<br>02: settlement_operator_ids is retained when the fixture supplies it |
| R11.2 | An operator may execute a settlement across any wallets; the permission does not grant access to another user requests or private activity items. | 09: operator permission grants no access to other users requests or private activity |
| R11.3 | POST /settlements requires an operator and an idempotency key; no token is 401, an authenticated non-operator is 403 forbidden. | 09: settlements require an operator: 401 without a token, 403 without the permission<br>09: an operator still needs an idempotency key<br>11: a non-operator is refused a malformed settlement without validating it *(advisory)* |
| R11.4 | The body is {"transfers":[{from_handle,to_handle,amount}, ..]}. | **not checked over HTTP** — The body shape is exercised by every settlement check; the malformed-shape rule is checked under R11.7. |
| R11.5 | transfers contains 1 to 32 objects. | 09: transfers must contain 1 to 32 objects |
| R11.6 | Each entry uses the ordinary payment amount, note and visibility rules, defaulting to an empty note and public. | 09: each entry follows the ordinary amount rules<br>09: each entry follows the ordinary note and visibility rules |
| R11.7 | An unknown handle is 404, a self-transfer is 422 self_payment, and a malformed batch shape is 422 validation_failed. | 09: a malformed batch shape is 422 validation_failed<br>09: an unknown handle is 404 and a self transfer is 422 self_payment |
| R11.8 | Entry errors take precedence in input order, before insufficient funds. | 09: entry errors take precedence in input order, ahead of insufficient funds |
| R11.9 | Unknown fields are ignored. | 09: unknown fields inside a transfer are ignored |
| R11.10 | A settlement is affordable when every wallet balance after all incoming and outgoing transfers is nonnegative; insufficient collective funds is 409 insufficient_funds. | 09: affordability is judged on the net position of every wallet<br>09: net affordability does not depend on the order of the transfers<br>09: a collectively unaffordable settlement is 409 and commits nothing<br>09: a cycle that nets to zero commits and leaves balances unchanged |
| R11.11 | Either all movements commit together or none do; failed validation claims no idempotency key and creates no payment or revision. | 09: a collectively unaffordable settlement is 409 and commits nothing<br>09: a failed settlement claims no idempotency key<br>09: either every movement commits or none does<br>12: concurrent settlements competing for the same funds stay consistent |
| R11.12 | Return 201 with settlement_id, committed_at and payments in input order. | 09: a settlement returns settlement_id, committed_at and payments in input order<br>09: a batch may repeat an identical transfer and both apply |
| R11.13 | Every member is an ordinary payment with settlement_id linking the batch; nonmembers expose null for that field. | 09: members carry the settlement id, a null request_id and one shared created_at |
| R11.14 | Members have a null request_id and the same server-assigned created_at, equal to committed_at. | 09: members carry the settlement id, a null request_id and one shared created_at |
| R11.15 | Constituents follow ordinary activity-feed visibility. | 09: members follow the ordinary feed visibility rule |
| R11.16 | The settlement response contains every member receipt. | 09: a settlement returns settlement_id, committed_at and payments in input order |
| R11.17 | Replays return 200 with the original complete response. | 09: a settlement replay returns 200 with the original complete response |
| R11.18 | This is the fifth idempotent write path in stage 1. | **not checked over HTTP** — A cross-reference to section 7 rather than a distinct behaviour. The five-path coverage is under R7.1. |
| R11.19 | A reset or import preserves settlement operator permissions, original payments, requests, settlement membership and retry responses. | 10: an unchanged export restores every observable fact about the state |

## Coordinator interpretations

These are not specification text. Each is checked as advisory, so a service that reads the
specification differently is reported but not rejected.

| ref | interpretation | checks |
|---|---|---|
| D4 | Every payment object carries settlement_id, null unless it is a settlement member. | 04: an ordinary payment carries settlement_id null |
| D5 | Email equality for email_taken is exact byte comparison, so case variants collide at the derived handle and return handle_taken. | 03: a case variant of a registered email collides at the derived handle |
| D6 | Signup check order: field validation 422, then email_taken 409, then handle_taken 409. | 03: field validation precedes the email and handle conflict checks |
| D7 | An email is valid when it has exactly one @, a non-empty local part and a non-empty domain part. | 03: an email with one @ and both parts non-empty is accepted |
| D8 | Timestamps are UTC with a literal +00:00 offset, never Z. | 01: timestamps use a numeric offset rather than the Z designator |
| D9 | Ordering is newest-first by created_at, tie-broken by a monotonic creation sequence, newest first. | 06: requests created in the same second are still ordered newest first |
| D10 | Seeded payments and requests get server timestamps at reset in fixture-array order: later in the array is newer. | 06: seeded requests are ordered by their position in the fixture array<br>07: seeded payments are ordered by their position in the fixture array |
| D11 | Request Content-Type is not enforced; bodies are parsed as JSON regardless. | 01: a request body is parsed regardless of its Content-Type |
| D12 | An absent or empty request body is the JSON value {}; a present body that is not a JSON object is 400 malformed_request. | 01: a body that parses but is not a JSON object is 400 malformed_request<br>01: an absent or empty request body is treated as {} |
| D13 | For /requests/{id}/*, a known request with the wrong caller is 403 forbidden, not 404. | 11: the wrong caller on a settled request is 403, not the state error |
| D14 | Idempotent write path order: parse body 400, authenticate 401, key present 400, key length 422, key resolution 200/409, then endpoint field validation. | 11: an unparseable body beats a missing idempotency key<br>11: a missing idempotency key beats endpoint field validation<br>11: an over-long idempotency key beats endpoint field validation |
| D15 | On /settlements the operator check 403 runs immediately after authentication, before the idempotency key is examined. | 09: a non-operator is refused before the idempotency key is examined |
| D20 | "Characters" means Unicode code points everywhere the specification counts them: the 200-character note, the 1..255 idempotency key, the 20-character handle truncation. | 04: the note boundary is counted in code points, not UTF-16 units<br>05: a key of 256 characters is 422 validation_failed |
| D21 | Handle derivation counts code points too: one underscore per non-[a-z0-9_] code point after lowercasing, then truncation to 20 code points. | 03: derivation replaces one underscore per code point, not per UTF-16 unit<br>03: derivation lowercases before replacing, even when lowercasing expands |
| D22 | One precedence chain on every write path: parse 400, authenticate 401, endpoint authorisation 403, key (400 missing / 422 length / 200 replay / 409 reuse), body field validation 422, resource resolution 404, resource-level authorisation 403, state 409, funds 409. | 11: body field validation beats resource resolution<br>11: a duplicate participant beats an unknown participant<br>11: body field validation beats resource resolution on the pay path too |
| D23 | The same chain applies per entry in /settlements: batch shape 422 first, then the first failing entry in input order, and within one entry self-transfer 422 ahead of unknown handle 404. The verifier dissents on the last clause; it is recorded in the decisions log and stays advisory. | 09: within one entry, a self transfer is reported ahead of the unknown handle |
| D24 | State 409 precedes funds 409: a terminal request whose payer is also short is request_not_pending, because a terminal status is dispositive without reference to any wallet. | 11: a terminal status beats a balance the payer does not have |

## Deliberately not covered by this suite

Named here so the record is explicit. None of these is dropped: each is either a
statement of scope with no behaviour to test, an explicit relaxation the suite relies on,
or a property of the container and the delivered tree that is verified out of band by
building and starting the image.

- **R1.6** — Only the HTTP API is required.
  - A statement of scope, not a behaviour. The suite tests the HTTP API only, which is what it asserts.
- **R1.10** — All amounts are exact integer counts of minor units.
  - Restated with enforcement detail as R4.1, R4.2 and R4.17, which are checked.
- **R1.11** — Deposits, top-ups, withdrawals, cards and bank integrations are out of scope; money moves only between existing wallets.
  - A statement of scope. Partially covered in substance: the suite checks that money only moves between existing wallets (unknown handle is 404 everywhere). The absence of deposit, top-up, withdrawal, card and bank endpoints is not something an acceptance suite can prove, only the absence of a documented one.
- **R2.1** — An HTTP service, a Dockerfile and a RUN.md with a command that builds and starts the service without manual setup.
  - Repository artefacts (Dockerfile, RUN.md) and the build command. Verified by inspecting the delivered tree and running the documented commands, not over HTTP.
- **R2.2** — A docker-compose.yml is optional.
  - States that a file is optional. Nothing to check.
- **R2.3** — The submission is a containerized HTTP service, not a Python package; language, framework and storage are unrestricted.
  - A constraint on the submission form, not on HTTP behaviour.
- **R2.4** — The image must run on its own with -e PORT=<port> and a port mapping.
  - How the container is started (-e PORT and a port mapping). The suite is pointed at whatever BASE_URL the launcher produced, so it exercises the result but cannot itself vary PORT. Checked out of band by starting the image twice.
- **R2.5** — No outbound network at run time; all dependencies, initialization and seed data work inside the one container.
  - Run-time network isolation. Checked out of band by starting the container with --network none; the suite is designed to pass in exactly that configuration, which is how it contributes evidence.
- **R2.7** — Runtime assets and dependencies are included in the image.
  - Image contents. Checked out of band by inspecting the built image.
- **R3.1** — Listen on 0.0.0.0 using the PORT environment variable, default 8080.
  - The bind address and the PORT default are properties of how the process starts. The suite proves the service answers on the URL it was given; 0.0.0.0 and the 8080 default are checked out of band.
- **R4.4** — Users identify recipients by handle; directory and user-search endpoints are out of scope.
  - A statement of scope: there is no directory endpoint to test. Recipient identification by handle is covered throughout.
- **R4.7** — If the derived handle is already taken the signup fails.
  - Restated with its error code as R6.7, which is checked.
- **R4.23** — An administrative balance endpoint is out of scope.
  - A statement of scope: there is no administrative balance endpoint to test.
- **R5.14** — limit is an integer 1 to 200, otherwise 422 validation_failed.
  - The same rule as the limit clause of R8.25, checked there for both list endpoints.
- **R5.15** — offset is an integer 0 or more, otherwise 422 validation_failed.
  - The same rule as the offset clause of R8.25, checked there for both list endpoints.
- **R6.9** — Authorization: Bearer <token>.
  - The header form itself is exercised by every authenticated call in the suite; there is no separate check because a wrong form would fail all of them.
- **R6.12** — Email verification, password reset, refresh tokens and role-management endpoints are out of scope.
  - A statement of scope: there are no such endpoints to test.
- **R8.36** — The relative order of two payments created within the same second is unspecified, and stable pagination during concurrent writes is not required for GET /activity.
  - An explicit relaxation, not a requirement. The suite relies on it: it never asserts an order between two items created in the same second, and never asserts pagination stability during concurrent writes.
- **R10.17** — State need not survive an abrupt container restart.
  - An explicit relaxation. The suite never restarts the container and never requires state to survive one.
- **R10.18** — Exports may contain credentials and session tokens; handle them as private test artifacts.
  - An instruction to whoever holds an export, not a service behaviour. Honoured rather than tested: the suite never writes an export to disk and never prints one.
- **R11.4** — The body is {"transfers":[{from_handle,to_handle,amount}, ..]}.
  - The body shape is exercised by every settlement check; the malformed-shape rule is checked under R11.7.
- **R11.18** — This is the fifth idempotent write path in stage 1.
  - A cross-reference to section 7 rather than a distinct behaviour. The five-path coverage is under R7.1.

## Running it

```sh
# against a container started however you like, on any port
BASE_URL=http://127.0.0.1:8080 node stage-1/acceptance/main.mjs

# or let the script wait for health first
BASE_URL=http://127.0.0.1:8080 ./stage-1/acceptance/run.sh
```

The suite talks HTTP and nothing else, so it runs unchanged against a container started
with `--network none`. Set `ALT_BASE_URL` to a second, independently started container to
additionally exercise R10.6 (an export that carries no dependency on its source).
