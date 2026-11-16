package org.tvshell.iptvnator.server;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import org.tvshell.iptvnator.backend.ImageCache;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * Shrinks a poster to card size before it is cached, so the WebView decodes a
 * ~30 KB image instead of the provider's multi-megabyte original. The decoder
 * subsamples while reading (inSampleSize), so a large source is never held at
 * full size.
 */
final class AndroidImageTranscoder implements ImageCache.Transcoder {

    /** A decoded bitmap costs 4 bytes a pixel; refuse sources that would not fit a small device. */
    private static final long MAX_SOURCE_PIXELS = 40_000_000L;
    private static final int JPEG_QUALITY = 82;

    @Override
    public byte[] downscale(byte[] original, int maxWidth) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(original, 0, original.length, bounds);
        int width = bounds.outWidth;
        int height = bounds.outHeight;
        if (width <= 0 || height <= 0) throw new IOException("Not a decodable image");
        if ((long) width * height > MAX_SOURCE_PIXELS) throw new IOException("Image has too many pixels");
        // Already card-sized (or smaller): keep the bytes as they are, animated GIFs included.
        if (width <= maxWidth) return original;

        int sample = 1;
        while (width / (sample * 2) >= maxWidth) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap decoded = null;
        Bitmap scaled = null;
        try {
            decoded = BitmapFactory.decodeByteArray(original, 0, original.length, options);
            if (decoded == null) throw new IOException("Image could not be decoded");
            int targetHeight = Math.max(1, Math.round((float) decoded.getHeight() * maxWidth / decoded.getWidth()));
            scaled = decoded.getWidth() > maxWidth ? Bitmap.createScaledBitmap(decoded, maxWidth, targetHeight, true) : decoded;
            boolean alpha = scaled.hasAlpha();
            ByteArrayOutputStream out = new ByteArrayOutputStream(48 * 1024);
            // PNG keeps transparent channel logos transparent; JPEG is much smaller for artwork.
            boolean ok = scaled.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            if (!ok) throw new IOException("Image could not be encoded");
            return out.toByteArray();
        } catch (OutOfMemoryError e) {
            throw new IOException("Not enough memory to shrink the image");
        } finally {
            if (scaled != null && scaled != decoded) scaled.recycle();
            if (decoded != null) decoded.recycle();
        }
    }
}
