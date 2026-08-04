/**
 * 向量嵌入提供者
 * 将文本转换为向量，用于语义相似性搜索
 * 使用本地 ONNX 模型，无需外部 API，支持中英文
 */

import { pipeline, env } from '@xenova/transformers';
import { log } from './logger';

// 配置 HuggingFace 镜像（国内网络需设置 HF_ENDPOINT 环境变量）
const hfEndpoint = process.env.HF_ENDPOINT || process.env.HF_MIRROR;
if (hfEndpoint) {
  env.remoteHost = hfEndpoint;
  log({ prefix: 'EmbeddingProvider', message: `HuggingFace 镜像: ${hfEndpoint}` });
}

export interface EmbeddingProvider {
  getEmbedding(text: string): Promise<number[]>;
  getDimension(): number;
}

/**
 * 本地 Embedding 提供者
 * 基于 @xenova/transformers（ONNX Runtime），模型自动下载到本地缓存
 * 默认使用多语言模型，支持中英文语义匹配
 *
 * 环境变量配置：
 * - EMBEDDING_MODEL: 模型名称，默认 Xenova/paraphrase-multilingual-MiniLM-L12-v2
 * - EMBEDDING_DIMENSION: 向量维度，默认 384
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractor: any = null;
  private model: string;
  private dimension: number;
  private initPromise: Promise<void> | null = null;

  constructor(config?: { model?: string; dimension?: number }) {
    this.model = config?.model || process.env.EMBEDDING_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
    this.dimension = config?.dimension || parseInt(process.env.EMBEDDING_DIMENSION || '384', 10);
    log({
      prefix: 'EmbeddingProvider',
      message: `本地 Embedding 已配置: model=${this.model}, dimension=${this.dimension}`
    });
  }

  /**
   * 懒加载模型（首次调用时下载并初始化）
   */
  private async ensureInitialized(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      log({ prefix: 'EmbeddingProvider', message: `正在加载模型 ${this.model}（首次使用需下载）...` });
      this.extractor = await pipeline('feature-extraction', this.model, {
        quantized: true,
      });
      log({ prefix: 'EmbeddingProvider', message: `模型加载完成: ${this.model}` });
    })();

    return this.initPromise;
  }

  async getEmbedding(text: string): Promise<number[]> {
    await this.ensureInitialized();
    const truncatedText = text.substring(0, 512);
    const output = await this.extractor!(truncatedText, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }

  getDimension(): number {
    return this.dimension;
  }
}
