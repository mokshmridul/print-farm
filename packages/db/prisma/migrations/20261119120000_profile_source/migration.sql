-- Presets from the profiles folder (synced at startup) beside admin uploads.
ALTER TABLE "SlicerProfileUpload" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "SlicerProfileUpload" ADD COLUMN "sourceKey" TEXT;

CREATE INDEX "SlicerProfileUpload_source_status_idx" ON "SlicerProfileUpload"("source", "status");
