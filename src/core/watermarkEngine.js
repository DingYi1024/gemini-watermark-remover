/**
 * Watermark engine main module
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */

import { calculateAlphaMap } from './alphaMap.js';
import { removeWatermark } from './blendModes.js';
import BG_48_PATH from '../assets/bg_48.png';
import BG_96_PATH from '../assets/bg_96.png';

/**
 * Detect watermark configuration based on image size
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @returns {Object} Watermark configuration {logoSize, marginRight, marginBottom}
 */
export function detectWatermarkConfig(imageWidth, imageHeight) {
    // Gemini's watermark rules:
    // If both image width and height are greater than or equal to 1024, use 96×96 watermark
    // Otherwise, use 48×48 watermark
    if (imageWidth >= 1024 && imageHeight >= 1024) {
        return {
            logoSize: 96,
            marginRight: 64,
            marginBottom: 64
        };
    } else {
        return {
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        };
    }
}

/**
 * Calculate watermark position in image based on image size and watermark configuration
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @param {Object} config - Watermark configuration {logoSize, marginRight, marginBottom}
 * @returns {Object} Watermark position {x, y, width, height}
 */
export function calculateWatermarkPosition(imageWidth, imageHeight, config) {
    const { logoSize, marginRight, marginBottom } = config;

    return {
        x: imageWidth - marginRight - logoSize,
        y: imageHeight - marginBottom - logoSize,
        width: logoSize,
        height: logoSize
    };
}

/**
 * Watermark engine class
 * Coordinate watermark detection, alpha map calculation, and removal operations
 */
export class WatermarkEngine {
    constructor(bgCaptures) {
        this.bgCaptures = bgCaptures;
        this.alphaMaps = {};
    }

    static async create() {
        const bg48 = new Image();
        const bg96 = new Image();

        await Promise.all([
            new Promise((resolve, reject) => {
                bg48.onload = resolve;
                bg48.onerror = reject;
                bg48.src = BG_48_PATH;
            }),
            new Promise((resolve, reject) => {
                bg96.onload = resolve;
                bg96.onerror = reject;
                bg96.src = BG_96_PATH;
            })
        ]);

        return new WatermarkEngine({ bg48, bg96 });
    }

    /**
     * Get alpha map from background captured image based on watermark size
     * @param {number} size - Watermark size (48 or 96)
     * @returns {Promise<Float32Array>} Alpha map
     */
    async getAlphaMap(size) {
        // If cached, return directly
        if (this.alphaMaps[size]) {
            return this.alphaMaps[size];
        }

        // Select corresponding background capture based on watermark size
        const bgImage = size === 48 ? this.bgCaptures.bg48 : this.bgCaptures.bg96;

        // Create temporary canvas to extract ImageData
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bgImage, 0, 0);

        const imageData = ctx.getImageData(0, 0, size, size);

        // Calculate alpha map
        const alphaMap = calculateAlphaMap(imageData);

        // Cache result
        this.alphaMaps[size] = alphaMap;

        return alphaMap;
    }

    /**
     * Remove watermark from image based on watermark size
     * @param {HTMLImageElement|HTMLCanvasElement} image - Input image
     * @returns {Promise<HTMLCanvasElement>} Processed canvas
     */
    async removeWatermarkFromImage(image) {
        // Create canvas to process image
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');

        // Draw original image onto canvas
        ctx.drawImage(image, 0, 0);

        // Get image data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Detect watermark configuration and position (content-aware fallback for mobile exports)
        const detection = await this.detectBestConfigAndPosition(imageData, canvas.width, canvas.height);
        const { config, position, alphaMap } = detection;

        // Remove watermark from image data
        removeWatermark(imageData, alphaMap, position);

        // Write processed image data back to canvas
        ctx.putImageData(imageData, 0, 0);

        return canvas;
    }

    async detectBestConfigAndPosition(imageData, imageWidth, imageHeight) {
        const baseConfig = detectWatermarkConfig(imageWidth, imageHeight);
        const basePosition = calculateWatermarkPosition(imageWidth, imageHeight, baseConfig);
        const baseAlphaMap = await this.getAlphaMap(baseConfig.logoSize);
        let best = {
            config: baseConfig,
            position: basePosition,
            alphaMap: baseAlphaMap,
            score: this.scoreCandidate(imageData, baseAlphaMap, basePosition)
        };

        const marginCandidates = [24, 32, 40, 48, 56, 64, 72, 80, 96, 112, 128];
        const sizeCandidates = [48, 96].filter(size => size <= imageWidth && size <= imageHeight);

        for (const logoSize of sizeCandidates) {
            const alphaMap = await this.getAlphaMap(logoSize);
            for (const marginRight of marginCandidates) {
                for (const marginBottom of marginCandidates) {
                    const x = imageWidth - marginRight - logoSize;
                    const y = imageHeight - marginBottom - logoSize;
                    if (x < 0 || y < 0) continue;

                    const candidateConfig = { logoSize, marginRight, marginBottom };
                    const candidatePosition = { x, y, width: logoSize, height: logoSize };
                    const score = this.scoreCandidate(imageData, alphaMap, candidatePosition);

                    if (score > best.score) {
                        best = {
                            config: candidateConfig,
                            position: candidatePosition,
                            alphaMap,
                            score
                        };
                    }
                }
            }
        }

        return best;
    }

    scoreCandidate(imageData, alphaMap, position) {
        const { x, y, width, height } = position;
        const imgWidth = imageData.width;
        const data = imageData.data;
        const n = width * height;

        let sumL = 0;
        let sumL2 = 0;
        let sumA = 0;
        let sumA2 = 0;
        let sumLA = 0;
        let clipCount = 0;
        let clipTotal = 0;

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const localIndex = row * width + col;
                const alpha = Math.min(alphaMap[localIndex], 0.95);
                const pixelIndex = ((y + row) * imgWidth + (x + col)) * 4;

                const r = data[pixelIndex];
                const g = data[pixelIndex + 1];
                const b = data[pixelIndex + 2];

                const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

                sumL += luminance;
                sumL2 += luminance * luminance;
                sumA += alpha;
                sumA2 += alpha * alpha;
                sumLA += luminance * alpha;

                if (alpha > 0.02) {
                    const denominator = 1.0 - alpha;
                    if (denominator > 0.0001) {
                        const restoredR = (r - alpha * 255) / denominator;
                        const restoredG = (g - alpha * 255) / denominator;
                        const restoredB = (b - alpha * 255) / denominator;

                        if (restoredR < -8 || restoredR > 263) clipCount++;
                        if (restoredG < -8 || restoredG > 263) clipCount++;
                        if (restoredB < -8 || restoredB > 263) clipCount++;
                        clipTotal += 3;
                    }
                }
            }
        }

        const invN = n > 0 ? 1 / n : 0;
        const meanL = sumL * invN;
        const meanA = sumA * invN;
        const varianceL = Math.max(0, sumL2 * invN - meanL * meanL);
        const varianceA = Math.max(0, sumA2 * invN - meanA * meanA);
        const covariance = sumLA * invN - meanL * meanA;
        const correlation = covariance / (Math.sqrt(varianceL * varianceA) + 1e-6);
        const clipRate = clipTotal > 0 ? clipCount / clipTotal : 1;

        return correlation - 0.2 * clipRate;
    }

    /**
     * Get watermark information (for display)
     * @param {number} imageWidth - Image width
     * @param {number} imageHeight - Image height
     * @returns {Object} Watermark information {size, position, config}
     */
    getWatermarkInfo(imageWidth, imageHeight) {
        const config = detectWatermarkConfig(imageWidth, imageHeight);
        const position = calculateWatermarkPosition(imageWidth, imageHeight, config);

        return {
            size: config.logoSize,
            position: position,
            config: config
        };
    }
}
