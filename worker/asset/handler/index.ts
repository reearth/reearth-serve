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

export const assetRoutes = new Hono<AppEnv>();

registerCreateUploadSessionRoute(assetRoutes);
registerCompleteUploadSessionRoute(assetRoutes);
registerUploadRoute(assetRoutes);
registerListFilesRoute(assetRoutes);
registerListRoute(assetRoutes);
registerGetRoute(assetRoutes);
registerExtractRoute(assetRoutes);
registerDeleteRoute(assetRoutes);
