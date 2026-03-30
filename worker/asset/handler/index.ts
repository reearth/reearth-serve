import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { registerCreateUploadSessionRoute } from "./create-upload-session";
import { registerCompleteUploadSessionRoute } from "./complete-upload-session";
import { registerUploadRoute } from "./upload";
import { registerListFilesRoute } from "./list-files";
import { registerListRoute } from "./list";
import { registerGetRoute } from "./get";
import { registerExtractRoute } from "./extract";
import { registerDeleteRoute } from "./delete";
import { registerUploadVersionRoute } from "./upload-version";
import { registerUpdateAssetRoute } from "./update-asset";
import { registerListVersionsRoute } from "./list-versions";
import { registerGetVersionRoute } from "./get-version";
import { registerUpdateVersionRoute } from "./update-version";
import { registerDeleteVersionRoute } from "./delete-version";
import { registerSetActiveVersionRoute } from "./set-active-version";

export const assetRoutes = new Hono<AppEnv>();

// Upload session routes (must come before /:id patterns)
registerCreateUploadSessionRoute(assetRoutes);
registerCompleteUploadSessionRoute(assetRoutes);

// Asset list and create (POST /, GET /)
registerUploadRoute(assetRoutes);
registerListRoute(assetRoutes);

// Version sub-routes (must come before /:id GET/PATCH/DELETE)
registerListVersionsRoute(assetRoutes);
registerGetVersionRoute(assetRoutes);
registerUpdateVersionRoute(assetRoutes);
registerDeleteVersionRoute(assetRoutes);
registerSetActiveVersionRoute(assetRoutes);

// Asset-level routes
registerListFilesRoute(assetRoutes);
registerExtractRoute(assetRoutes);
registerUploadVersionRoute(assetRoutes);
registerUpdateAssetRoute(assetRoutes);
registerGetRoute(assetRoutes);
registerDeleteRoute(assetRoutes);
