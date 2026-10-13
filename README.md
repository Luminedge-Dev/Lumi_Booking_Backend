# Luminedge Booking Portal — Backend API & Platform Engine

<div align="center">

  <p align="center">
    <strong>Enterprise-grade exam booking, mock-test entitlement governance, and TRF evaluation engine.</strong>
  </p>
  <p align="center">
    Architected for high-concurrency seat reservation, atomic multi-document transactions, and dual-runtime deployment on Vercel Serverless & Node.js daemons.
  </p>

  <!-- Badges -->
  <p align="center">
    <a href="#"><img src="https://img.shields.io/badge/Node.js-22.x-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 22.x" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Express-4.22.x-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express 4" /></a>
    <a href="#"><img src="https://img.shields.io/badge/MongoDB-Native_Driver_6.x-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB Native" /></a>
    <a href="#"><img src="https://img.shields.io/badge/JWT-Secure_Cookie_Auth-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white" alt="JWT Auth" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Vercel-Serverless_API-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel Deployment" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Status-Production_Ready-success?style=for-the-badge" alt="Production Status" /></a>
  </p>

  <!-- Navigation / Quick Links -->
  <p align="center">
    <a href="#-project-overview"><strong>Explore Overview</strong></a> •
    <a href="#-system-architecture--internal-workflow"><strong>Architecture</strong></a> •
    <a href="#-api-endpoints--data-flow"><strong>API Reference (45 Routes)</strong></a> •
    <a href="#-key-features"><strong>Features</strong></a> •
    <a href="#-installation--local-setup"><strong>Setup Guide</strong></a> •
    <a href="#-deployment"><strong>Deployment</strong></a>
  </p>

  <p align="center">
    <a href="https://luminedge.vercel.app" target="_blank">🌐 Live Production App</a> &nbsp;|&nbsp;
    <a href="https://luminedge-backend.vercel.app" target="_blank">⚡ API Gateway</a> &nbsp;|&nbsp;
    <a href="#-system-architecture--internal-workflow" target="_blank">📖 Technical Documentation</a>
  </p>

</div>

---

## 📸 Project Preview

The backend powers high-fidelity interactions across four distinct user roles (**Student**, **Teacher**, **BDM**, and **System Administrator**), delivering strict seat isolation, dynamic scoring rubrics, and automated Test Report Form (TRF) generation.

---

## 📌 Project Overview

**Luminedge Booking Portal** is a production-grade educational scheduling and examination management backend. It powers the end-to-end operational lifecycle for standardized test preparation institutes (IELTS, TOEFL, PTE, Duolingo, GRE), governing everything from initial mock package entitlements to Test Center physical seat management and digital Test Report Form (TRF) delivery.

### The Problem It Solves
1. **Overselling & Concurrency Clashes:** Physical testing centers have finite room and workstation capacity. Traditional CRUD backends suffer from race conditions where two simultaneous bookings grab the same final seat.
2. **Complex Entitlement Models:** Students purchase packages with variable mock counts, expiry deadlines, and home-based vs. on-campus permissions that must be strictly audited.
3. **Disjointed Evaluation Lifecycles:** Testing evaluations involve four distinct skill evaluators (Listening, Reading, Writing, Speaking) whose feedback must be aggregated into an official TRF before PDF delivery.
4. **Serverless Cold-Start Fragility:** Running long-lived background jobs and SMTP email queues on modern serverless infrastructure often leads to connection pool starvation, dropped emails, or broken socket states.

### Target Audience & Ecosystem
* **Students (`user`):** Purchase mock balances, browse interactive schedule calendars, book at-home or center slots, monitor progress, and download official band score TRFs.
* **Faculty (`teacher`):** Access assigned batches, evaluate specific skill sections (L/R/W/S), leave granular band-score feedback, and approve test completions.
* **Business Development (`bdm`):** Track student enrollment velocities, monitor branch attendance, and coordinate on-ground testing operations.
* **Platform Operations (`admin`):** Full control over course master catalogs, schedule slot builders, money receipt verification, user account status, teacher assignments, and system-wide analytics.

---

## 💡 Core Value: Why This Project Matters

This backend is deliberately designed as a **mission-critical transaction orchestrator**, far surpassing standard CRUD tutorials:

* 🛡️ **Zero-Oversell ACID Guarantees:** Leverages MongoDB Multi-Document Transactions (`ClientSession`) to coordinate atomic updates across `users`, `schedules`, and `bookingMock` collections. If seat decrement fails, the balance rollback is instant and complete.
* ⚡ **Dual-Runtime Adaptability:** Runs seamlessly as an asynchronous event-driven **Vercel Serverless Function** using non-blocking response continuations (`@vercel/functions` `waitUntil`) while maintaining full compatibility as a dedicated **Node.js Long-Running Daemon** with scheduled crons (`node-cron`).
* 🔒 **Multi-Layer Defensive Security:** Full defense-in-depth protection pairing `helmet`, `express-mongo-sanitize` (blocking NoSQL operator injection across body/query/params), multi-tiered `express-rate-limit` (strict guards on auth, global protection across API), and live token status revocation.
* 📬 **Resilient SMTP Delivery:** Implements a pooled SMTP worker with connection reuse, auto-TLS fallback, non-blocking delivery queues, and bounded batch continuations with cryptographic worker secrets (`CRON_SECRET`).

---

## 🛠️ Tech Stack & Technical Rationale

| Category | Technology | Version | Purpose & Architecture Rationale |
| :--- | :--- | :--- | :--- |
| **Runtime** | **Node.js** | `^22.x LTS` | High-throughput asynchronous V8 engine utilizing modern ES modules and native performance optimizations. |
| **Framework** | **Express.js** | `^4.22.3` | Lightweight, unopinionated HTTP foundation with custom middleware chaining and route prioritization. |
| **Database** | **MongoDB Native Driver** | `^6.12.0` | Direct native driver bypassing ORM overhead; enables low-level cursor control and granular transaction management. |
| **Authentication** | **JWT & BCrypt** | `jsonwebtoken 9.0` / `bcryptjs 2.4` | Stateless bearer tokens paired with HTTP-only, `SameSite=None`, `Secure` cookies for cross-origin SPA security. |
| **Security** | **Helmet & Mongo Sanitize** | `helmet 8.3` / `mongo-sanitize 2.2` | Comprehensive HTTP header hardening (HSTS, CSP, XSS) and sanitization against NoSQL injection operators. |
| **Rate Limiting** | **Express Rate Limit** | `^8.6.2` | Dual-tier IP rate limiting separating high-risk auth routes (login/register) from general read routes. |
| **File Handling** | **Multer** | `^1.4.5-lts.2` | In-memory streaming (`memoryStorage`) with strict 10MB bounds for secure TRF PDF ingestion and email forwarding. |
| **Email Engine** | **Nodemailer** | `~10.0.9` | Pooled SMTP transport with custom retry backoff, dynamic STARTTLS/TLS port resolution, and HTML templating. |
| **Scheduler** | **Node-Cron** | `^3.0.3` | Daily scheduled cron tasks (10:00 Asia/Dhaka) for entitlement expiry checks and automated student notifications. |
| **Deployment** | **Vercel Serverless** | `@vercel/node 63.x` | Global edge distribution with zero-idle server overhead, auto-scaling, and managed TLS certificates. |

---

## 🏗️ System Architecture & Internal Workflow

The platform implements a **decoupled, multi-tiered architecture** where incoming HTTP requests traverse strict security gates, dependency injection layers, transaction managers, and persistence models.

### Request Lifecycle Walkthrough

```text
Incoming Request
    │
    ▼
1. Edge & Proxy Ingestion  ───► Vercel edge terminates TLS; trust proxy=1 normalizes client IP
    │
    ▼
2. Security Pipeline        ───► Helmet() sets CSP/HSTS; CORS rejects unauthorized origins (403)
    │
    ▼
3. Input Sanitization       ───► mongoSanitize() strips $- and dot-prefixed query/body keys
    │
    ▼
4. Rate Limiting            ───► globalLimiter (100 req/min) or authLimiter (10 req/15min)
    │
    ▼
5. Authentication Guard     ───► Token decoded; DB query checks user is active, not deleted,
    │                            and password has not changed since token issuance
    │
    ▼
6. Business Logic & ACID    ───► Controller validates payload; opens MongoDB ClientSession
    │                            Decrements user.mock, decrements schedule slot, writes bookingMock
    │
    ▼
7. Response & Post-Action   ───► Immediate HTTP 200/201 response emitted to client
    │
    └──────────────────────────► waitUntil() dispatches async confirmation emails in background
```

---

## 🔌 API Endpoints & Data Flow

The backend exposes **45 RESTful endpoints** registered under `/api/v1` (plus root health monitoring), grouped into six cohesive domain routers.

### 1. Authentication & Identity (`auth.routes.js`)
*Manages user onboarding, credential verification, secure session cookies, and self-service password recovery.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/register` | `Public` | Student registration with profile details | `{ email, password, name, contactNo, ... }` → `User Object` |
| `POST` | `/api/v1/login` | `Public` | Authenticate credentials; issue JWT cookie | `{ email, password }` → Sets HTTP-only cookie, returns token |
| `POST` | `/api/v1/auth/forget-password` | `Public` | Generate signed 15m password reset token | `{ email }` → Sends reset link via email |
| `PUT` | `/api/v1/auth/reset-password` | `Public` | Update password via verified reset token | `{ token, newPassword }` → Updated status |
| `PUT` | `/api/v1/user/change-password` | `Token` | Authenticated password change | `{ currentPassword, newPassword }` → Updates hash & `passwordChangedAt` |

### 2. Booking & Seat Reservation Engine (`booking.routes.js`)
*Transactional seat reservations, center room allocation, bulk attendance, and automated balance restoration.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/user/book-slot` | `Token` | Book Home or Center mock seat (ACID) | `{ scheduleId, slotId, location, testType }` → `Booking Record` |
| `DELETE` | `/api/v1/bookings/:bookingId` | `Token` | Cancel booking & atomically restore mock slot | URL param → Restores `user.mock` & increment slot capacity |
| `GET` | `/api/v1/user/bookings/:userId` | `Token` | Retrieve active & past bookings for a user | Returns list of bookings with schedule metadata |
| `POST` | `/api/v1/user/attendance/bulk` | `Staff` | Mark attendance across students | `{ attendances: [{ bookingId, status }] }` → Batch result |
| `GET` | `/api/v1/admin/bookings/home-with-users` | `Staff` | List all home-based bookings with user info | Aggregated array of home bookings |
| `GET` | `/api/v1/admin/bookings/by-schedule/:scheduleId` | `Staff` | List seated students for a specific test schedule | Filtered seated roster |
| `GET` | `/api/v1/admin/bookings` | `Admin` | Full booking registry with pagination/filters | Global booking collection query |
| `PUT` | `/api/v1/user/bookings/:scheduleId` | `Admin` | Batch update bookings under a schedule | Schedule-level status modifications |
| `POST` | `/api/v1/send-reminder` | `Admin*` | Dispatch bounded batch email reminders | Bounded SMTP delivery with recursive continuation |

### 3. User & Entitlement Administration (`user.routes.js`)
*Manages mock package balances, profile edits, administrative approval gates, and soft-delete/block security.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/users` | `Staff` | Search and filter all registered users | Paginated student profiles with entitlement counts |
| `GET` | `/api/v1/user/all` | `Admin` | Comprehensive administrative user listing | All user records with status flags |
| `GET` | `/api/v1/profile/:userId` | `Token` | Fetch student profile and mock test quotas | User profile, remaining `mock`, and `totalMock` |
| `GET` | `/api/v1/user/status/:userId` | `Token` | Retrieve verification & active account status | `{ status, role, mock, ... }` |
| `PUT` | `/api/v1/user/status/:userId` | `Admin` | Update account status (e.g., verified/active) | `{ status: "active" \| "blocked" }` |
| `POST` | `/api/v1/user/request-profile-edit` | `Token` | Student requests field modification approval | `{ changes: { name, contactNo, ... }, note }` |
| `PUT` | `/api/v1/user/approve-profile-edit/:userId` | `Admin` | Approve or reject student profile request | Applies requested changes to database |
| `PUT` | `/api/v1/user/update-multiple/:userId` | `Admin` | Batch update user details & mock balances | Updates `mock`, `totalMock`, and package items |
| `PUT` | `/api/v1/user/update-one/:userId` | `Admin` | Incremental single-field update | Targeted record modification |
| `PUT` | `/api/v1/user/block/:userId` | `Admin` | Instantly revoke access & mark blocked | Updates `status: 'blocked'`, invalidating tokens |
| `GET` | `/api/v1/users/with-profile-request` | `Admin` | List all pending student edit requests | Queue of unapproved profile updates |
| `GET` | `/api/v1/user/:userId` | `Token` | Get detailed user information | Full user document |

### 4. Schedules & Course Catalog (`schedule.routes.js`)
*Course configuration, Home-testing compatibility rules, and room slot generation.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/courses` | `Public` | Catalog of active test programs (IELTS, etc.) | Array of courses and supported testing systems |
| `POST` | `/api/v1/admin/create-schedule` | `Admin` | Provision new exam schedule with time slots | `{ courseId, startDate, timeSlots: [...] }` |
| `GET` | `/api/v1/schedule/:date/:courseId` | `Token` | Query available test slots by date & program | Slot availability, remaining capacity |
| `GET` | `/api/v1/schedule/:userId` | `Token` | Retrieve candidate-specific schedule assignments | Candidate schedules |
| `GET` | `/api/v1/admin/get-schedules` | `Staff` | List all operational test schedules | Comprehensive schedule overview |
| `DELETE` | `/api/v1/admin/delete-schedule/:id` | `Admin` | Delete or deactivate a testing schedule | Deletes schedule document |

### 5. Evaluation, Feedback & TRF System (`feedback.routes.js`)
*Skill-by-skill candidate assessment (L/R/W/S), teacher assignments, and in-memory PDF TRF mailing.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/admin/save-feedback` | `Token` | Submit teacher evaluation for skill segment | `{ scheduleId, skill: "W", bandScore, feedback }` |
| `PUT` | `/api/v1/admin/save-admin-section` | `Admin` | Finalize overall test result & band scores | Overarching exam evaluation & final score |
| `GET` | `/api/v1/admin/get-admin-section/:userId/:scheduleId` | `Token` | Retrieve administrative score summary | Final test evaluation breakdown |
| `GET` | `/api/v1/admin/feedback-status/:userId/:scheduleId` | `Token` | Check completion status across 4 skills | `{ listening: true, writing: false, ... }` |
| `PUT` | `/api/v1/admin/users/:userId/schedules/:scheduleId/teacher` | `Admin` | Assign specific teacher to student schedule | Links teacher email to student schedule |
| `GET` | `/api/v1/admin/assigned-teachers/:userId/:scheduleId` | `Token` | View designated teachers for a student | Map of assigned faculty per skill |
| `PUT` | `/api/v1/admin/bookings/:bookingId/teacher` | `Admin` | Assign faculty to home-based booking | Home test evaluation assignment |
| `GET` | `/api/v1/admin/trf-email-status/:userId/:scheduleId` | `Token` | Check if candidate TRF has been emailed | Timestamp and delivery status |
| `POST` | `/api/v1/admin/send-trf-email/:userId/:scheduleId` | `Admin` | Upload PDF report & email to candidate | Multipart/form-data (10MB limit) via Multer |

### 6. Analytics & Operational Reporting (`stats.routes.js`)
*High-performance MongoDB aggregation pipelines for organizational intelligence and financial metrics.*

| Method | Route | Access | Purpose | Key Payload / Response |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/stats/users/mock-types/range` | `Admin` | Date-range aggregation of mock package sales | Aggregated volume by test program |
| `GET` | `/api/v1/admin/stats/users/mock-types/monthly` | `Admin` | Monthly trend metrics for mock test volume | Month-by-month candidate intake |
| `GET` | `/api/v1/admin/stats/bookings/attendance` | `Admin` | High-level candidate attendance ratios | Present vs. Absent vs. Cancelled rates |
| `GET` | `/api/v1/admin/user-budget/:userId/:scheduleId` | `Admin` | Entitlement and balance auditing per candidate | Financial and credit consumption audit |

---

## ✨ Key Features

### 👤 User Experience & Self-Service
* **Interactive Slot Discovery:** Real-time visibility into open exam dates, physical center seat counts, and home test availability.
* **Instant Self-Service Cancellation:** Students can cancel upcoming tests before deadlines with immediate, automated balance refunds.
* **Digital Profile Governance:** Secure submission flow for personal identity revisions requiring administrative audit trails.

### ⚡ Concurrency & ACID Integrity
* **Atomic Seat Locking:** Multi-document transactional integrity ensuring that physical test slots are never double-booked under concurrent traffic.
* **Quota Enforcement:** Strict validation checking user mock balance (`user.mock > 0`) and per-course purchase caps before booking commits.
* **Dual Testing Modalities:** Intelligent routing for **Test Center** (physical seat constraints) vs. **Home-Based** (course-system compatibility rules).

### 🛡️ Enterprise Security & Role Governance
* **Four-Tiered RBAC:** Granular authorization checks isolating privileges across `user`, `teacher`, `bdm`, and `admin`.
* **Live Token Invalidation:** JWT checks verify real-time database state; deactivated, blocked, or password-reset accounts are instantly locked out.
* **NoSQL Injection Defense:** Middleware stripping `$` and `.` operators request-wide, paired with Helmet security headers and strict CORS origin validation.

### 📋 TRF & Academic Evaluation Pipeline
* **Modular Band Scoring:** Independent evaluation workspaces for Listening, Reading, Writing, and Speaking with assigned faculty validation.
* **In-Memory PDF Dispatch:** Secure multi-part document ingestion that emails official TRF certificates directly to candidates without writing sensitive PDFs to disk.
* **Attendance Auditing:** Bulk staff attendance submission triggering automatic status updates and communication records.

### 📬 Asynchronous Delivery & Cron Subsystem
* **Non-Blocking Mail Delivery:** Asynchronous email dispatch using Vercel `waitUntil` prevents slow SMTP connections from blocking HTTP client responses.
* **Scheduled Expiry Warnings:** Automated daemon cron executing daily at 10:00 AM (Asia/Dhaka) notifying candidates of impending entitlement expirations.


## 📂 Folder Structure

The codebase is organized into cleanly decoupled directories separating network protocols, persistence layer, background workers, and administrative scripts:

```bash
Lumi_Booking_Backend/
 ┣ config/                          # Persistence & Infrastructure Configuration
 ┃ ┣ databaseName.js                 # Database name resolution & overrides
 ┃ ┣ db.js                           # MongoClient connection pool, health checks, reconnect logic
 ┃ ┗ indexDefinitions.js             # 18 official MongoDB collection index definitions
 ┣ jobs/                            # Long-Running Daemon Jobs
 ┃ ┗ reminderCron.js                 # Daily 10:00 AM (Asia/Dhaka) mock expiry notification cron
 ┣ middleware/                      # HTTP Request Interceptors & Security Filters
 ┃ ┣ auth.js                         # JWT verification, live DB state check, role guards (Admin/Staff)
 ┃ ┣ rateLimit.js                    # Dual-tier rate limiters (Global 100/min & Auth 10/15min)
 ┃ ┗ upload.js                       # Multer in-memory storage gate (10MB limit) for TRF PDFs
 ┣ routes/                          # Modular API Routers (45 Endpoints Total)
 ┃ ┣ auth.routes.js                  # Registration, login, password recovery, credential change
 ┃ ┣ booking.routes.js               # ACID Home/Center booking, cancellation, attendance, reminders
 ┃ ┣ feedback.routes.js              # Faculty evaluation, band scoring, teacher assignment, TRF emails
 ┃ ┣ schedule.routes.js              # Course catalog, schedule creation, room availability queries
 ┃ ┣ stats.routes.js                 # Analytical aggregations, user budgets, attendance ratios
 ┃ ┗ user.routes.js                  # User administration, profile updates, approval queues, blocking
 ┣ scripts/                         # Maintenance & Administrative CLI Utilities
 ┃ ┣ ensure-indexes.js               # Manual MongoDB index sync script
 ┃ ┣ inspect-courses.js              # Course catalog inspection tool
 ┃ ┣ mint-service-token.js           # CLI generator for internal system JWTs
 ┃ ┣ send-test-email.js              # SMTP connection diagnostic utility
 ┃ ┣ set-home-based-systems.js       # Configure Home test system permissions
 ┃ ┗ unset-home-based-systems.js     # Reset Home test system permissions
 ┣ app.js                           # Express application factory, security headers, routing order
 ┣ emailSender.js                   # Pooled SMTP client, retry backoffs, HTML email templates
 ┣ index.js                         # App bootstrap, environment validator, Vercel handler, Node listener
 ┣ vercel.json                      # Vercel serverless routing & build specifications
 ┣ package.json                     # Dependency manifests & runtime engine definitions
 ┗ README.md                        # Master technical documentation & architectural reference
```

---

## 🗄️ Database Architecture & Indexes

The persistence layer uses **MongoDB Native Driver 6.x** without an intermediary ORM, maintaining lean memory overhead and explicit control over multi-document transactions.

### Core Collections
1. **`users`**: Candidate identity records, hashed credentials, roles (`user`, `admin`, `bdm`, `teacher`), account status, remaining `mock` balance, `totalMock` allocations, and dynamic evaluation keys (`resultsBySchedule`, `teachersBySchedule`).
2. **`courses`**: Academic programs (IELTS Academic, General Training, etc.) and permitted Home testing systems (`homeBasedSystems`).
3. **`schedules`**: Exam sessions featuring date ranges, location identifiers, room limits, and granular arrays of available `timeSlots`.
4. **`bookingMock`**: Reservation ledger tracking candidate test bookings, seat numbers, location (`home` vs. `center`), attendance status (`present`, `absent`, `pending`), and TRF delivery timestamps.

### Production Index Strategy (18 Indexes)
* **`users` (8 indexes):** Unique `email`, `status`, `role`, `createdAt`, `mocks.mrValidationExpiry`, `profileChangeRequestStatus`, `nameLower`, `emailLower`.
* **`bookingMock` (8 indexes):** `userId`, `scheduleId`, `location`, `bookingDate`, `attendance`, compound `(userId, scheduleId)`, compound `(userId, location)`, compound `(userId, bookingDate desc)`.
* **`schedules` (2 indexes):** Compound `(courseId, startDate, endDate)`, single `startDate`.

---

## 📄 License & Ownership

This project is proprietary software developed for **Luminedge**. All rights reserved.

---

<div align="center">
  <sub>Engineered with precision for high-stakes academic examination governance.</sub>
</div>
