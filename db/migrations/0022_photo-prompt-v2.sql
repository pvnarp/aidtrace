-- IAC-384 prompt v2 (docs/ASSUMPTIONS.md section 85): additive widening of photo_read_versions; append-only triggers untouched.
-- Re-adding the check validates the existing v1 rows, which is intended.
ALTER TABLE "receipt_photo_reads" DROP CONSTRAINT "photo_read_versions";--> statement-breakpoint
ALTER TABLE "receipt_photo_reads" ADD CONSTRAINT "photo_read_versions" CHECK ("receipt_photo_reads"."prompt_version" in ('receipt-photo-v1','receipt-photo-v2') and "receipt_photo_reads"."schema_version" = 'receipt-transcript-v1');