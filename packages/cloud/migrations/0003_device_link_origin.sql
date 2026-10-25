-- Where a desktop sign-in was started, shown on the approval page so a request someone else
-- started (and sent you a link to) stands out.
ALTER TABLE device_links ADD COLUMN origin_ip TEXT;
ALTER TABLE device_links ADD COLUMN origin_place TEXT;
