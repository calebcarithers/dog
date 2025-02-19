import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import * as httpSignature from 'http-signature';
import { catchError, firstValueFrom } from 'rxjs';
import * as WebSocket from 'ws';
import { Configuration } from '../config/configuration';
import { sleep } from '../helpers/sleep';
import { Address, Tx } from './blockcypher.interfaces';

@Injectable()
export class BlockcypherService implements OnModuleInit {
  private readonly logger = new Logger(BlockcypherService.name);
  private readonly baseUrl = 'https://api.blockcypher.com/v1/doge/main';
  private ws: WebSocket;
  private token: string;
  private signingPubKey =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEflgGqpIAC9k65JicOPBgXZUExen4rWLq05KwYmZHphTU/fmi3Oe/ckyxo2w3Ayo/SCO/rU2NB90jtCJfz9i1ow==';

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService<Configuration>,
  ) {
    this.token = this.config.get('blockCypherKey');
  }

  onModuleInit() {
    this.logger.log('blockcypher init');
  }

  private get authConfig() {
    return { params: { token: this.token } };
  }

  async getBalance(address: string) {
    const { data } = await firstValueFrom(
      this.http
        .get(this.baseUrl + '/addrs/' + address + '/balance', this.authConfig)
        .pipe(
          catchError((e) => {
            this.logger.error(e);
            throw e;
          }),
        ),
    );
    return this.toWholeUnits(data.final_balance);
  }

  async getAddress(address: string) {
    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl + '/addrs/' + address, this.authConfig).pipe(
        catchError((e) => {
          this.logger.error(e);
          throw e;
        }),
      ),
    );
    return data;
  }

  async getAllTxs(address: string, after?: number): Promise<Array<Tx>> {
    let txs = [];
    const data = await this.getAddressFull(address, undefined, after);
    txs = txs.concat(data.txs);

    let hasMore = data.hasMore;
    while (hasMore) {
      this.logger.log(`paging blockcypher for ${address}:${txs.length}`);
      const lastTx = txs[txs.length - 1];
      const newData = await this.getAddressFull(
        address,
        lastTx.block_height,
        after,
      );
      txs = txs.concat(newData.txs);

      hasMore = newData.hasMore;
      this.logger.log(`HAS MORE: ${hasMore}`);

      // don't get rate limited by blockcypher
      await sleep(1);
    }
    return txs;
  }

  private async getAddressFull(
    address: string,
    before?: number,
    after?: number,
  ) {
    const { data } = await firstValueFrom(
      this.http
        .get<Address>(this.baseUrl + '/addrs/' + address + '/full', {
          params: {
            ...this.authConfig.params,
            limit: 50,
            txlimit: 1000,
            before,
            after,
          },
        })
        .pipe(
          catchError((e) => {
            this.logger.error(e);
            throw e;
          }),
        ),
    );
    return data;
  }

  // https://www.blockcypher.com/dev/bitcoin/#using-webhooks
  async createWebhook(event: object) {
    const { data } = await firstValueFrom(
      this.http
        .post(
          this.baseUrl + '/hooks',
          { ...event, signKey: 'preset' },
          this.authConfig,
        )
        .pipe(
          catchError((e) => {
            this.logger.error(e);
            throw e;
          }),
        ),
    );
    return data;
  }

  async deleteWebhook(id: string) {
    const { data } = await firstValueFrom(
      this.http
        .delete(this.baseUrl + '/hooks' + `/${id}`, this.authConfig)
        .pipe(
          catchError((e) => {
            this.logger.error(e);
            throw e;
          }),
        ),
    );
    return data;
  }

  async listWebhooks() {
    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl + '/hooks', this.authConfig).pipe(
        catchError((e) => {
          this.logger.error(e);
          throw e;
        }),
      ),
    );
    return data;
  }

  async getWebhookById(id: string) {
    const { data } = await firstValueFrom(
      this.http.get(this.baseUrl + '/hooks' + `/${id}`, this.authConfig).pipe(
        catchError((e) => {
          this.logger.error(e);
          throw e;
        }),
      ),
    );
    return data;
  }

  // @next -- not working rn
  getIsHookPingSafe(request: Request) {
    this.logger.log('verifying webhook ping');

    const parsedSignature = httpSignature.parse(request, {
      headers: ['(request-target)', 'digest', 'date'],
      authorizationHeaderName: 'signature',
    });
    this.logger.log(parsedSignature);

    const publicKeyPEM = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(
      this.signingPubKey,
      'base64',
    )}\n-----END PUBLIC KEY-----`;

    const pem = crypto.createPublicKey({
      key: publicKeyPEM,
      format: 'pem',
    });

    return crypto.verify(
      'ECDSA-SHA256',
      Buffer.from(parsedSignature.signingString),
      Buffer.from(publicKeyPEM),
      Buffer.from(parsedSignature.params.signature),
    );
  }

  toWholeUnits(amount: number) {
    return amount / 10 ** 8;
  }
}
