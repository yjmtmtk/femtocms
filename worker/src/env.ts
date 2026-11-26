export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  SITE_NAME: string;
  CORS_ORIGINS?: string;
}
