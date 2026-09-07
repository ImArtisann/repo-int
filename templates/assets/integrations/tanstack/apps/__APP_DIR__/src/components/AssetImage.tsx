import { Image, type ImageProps } from "@unpic/react";
import type { AssetPath } from "@repo/assets/manifest";
import { ASSET_IMAGE_OPERATIONS, assetImageOptions } from "@repo/assets/config";
import { assetBreakpoints, assetDimensions, assetUrl } from "@repo/assets/urls";

type AssetImageProps = Omit<
    ImageProps,
    | "src"
    | "width"
    | "height"
    | "aspectRatio"
    | "layout"
    | "cdn"
    | "fallback"
    | "operations"
    | "options"
    | "breakpoints"
    | "alt"
> & {
    asset: AssetPath;
    alt: string;
    width?: number;
};

export function AssetImage({ asset, width, alt, ...props }: AssetImageProps) {
    const host = import.meta.env.VITE_ASSETS_HOST;
    if (!host) throw new Error("Set VITE_ASSETS_HOST in the app's .env to your R2 custom domain.");
    const dimensions = assetDimensions(asset);
    const displayWidth = width ?? dimensions.width;
    const transform = import.meta.env.VITE_ASSETS_TRANSFORM === "true";
    return (
        <Image
            {...props}
            alt={alt}
            src={assetUrl(asset, `https://${host}`)}
            width={displayWidth}
            height={Math.round((displayWidth * dimensions.height) / dimensions.width)}
            layout="constrained"
            cdn={transform ? "cloudflare" : undefined}
            options={assetImageOptions(host)}
            operations={ASSET_IMAGE_OPERATIONS}
            breakpoints={transform ? assetBreakpoints(asset) : []}
        />
    );
}
