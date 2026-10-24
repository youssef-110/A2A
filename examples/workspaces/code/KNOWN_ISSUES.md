# Known issues

- INV-311 (open): Invoice PDF export does nothing in Safari. Reported via support ticket T-1051.
  Suspected cause is in `src/invoices/export.js`; not yet investigated.
- INV-298 (fixed in 4be1c2d): refund amounts rounded down instead of to nearest cent.
