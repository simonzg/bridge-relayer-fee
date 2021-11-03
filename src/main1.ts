require("./utils/validateEnv");

import path from "path";

import BigNumber from "bignumber.js";
import { ChainConfig, Network, mainConfigs, UNIT_WEI } from "./const";
import { saveCSVFromObjects } from "./utils/csv";
import { SCAN_APIS } from "./scan";
import { ethers } from "ethers";
import { getTokenPrice } from "./utils";

const {
  RELAYER_ADDRESSES,
  ETH_START_BLOCK,
  ETH_END_BLOCK,
  METER_START_BLOCK,
  METER_END_BLOCK,
  BSC_START_BLOCK,
  BSC_END_BLOCK,
  AVA_START_BLOCK,
  AVA_END_BLOCK,
  MOONBEAM_START_BLOCK,
  MOONBEAM_END_BLOCK,
} = process.env;

export class RelayerFeeCalculator {
  private configs: ChainConfig[] = mainConfigs;
  private relayerAddrs = {};
  private startAndEndBolck = {};

  constructor() {
    for (const addr of RELAYER_ADDRESSES.split(",")) {
      const lowerCaseAddr = addr.toLowerCase();
      this.relayerAddrs[lowerCaseAddr] = true;
    }
  }

  async start() {
    const { totalGas, gasSubtotals, bridgeBalances } = await this.resolveTx();

    await this.formatAndWriteCsv(gasSubtotals, totalGas, bridgeBalances);
  }

  async formatAndWriteCsv(gasSubtotals, totalGas, bridgeBalances) {
    let results = [];
    console.log("Gas Usage Details");
    for (const c of this.configs) {
      let { startBlock, endBlock } = this.startAndEndBolck[c.network];
      for (const addr in this.relayerAddrs) {
        const subtotal = gasSubtotals[addr];
        const percent = subtotal.dividedBy(totalGas);

        results.push({
          network: c.network,
          addr,
          award: new BigNumber(bridgeBalances[c.network])
            .times(percent)
            .toFixed(0),
          gasPercent: percent.toFixed(3),
          gasUsed: subtotal.toFixed(0),
          totalGas: totalGas.toFixed(0),
          startBlock,
          endBlock,
        });
        console.log(
          `  Relayer ${addr} used gas: ${subtotal} = ${percent
            .times(100)
            .toFixed(1)}% of total gas in ${c.network}`
        );
      }
    }

    const date = new Date();
    const year = date.getFullYear();
    const month = `0${date.getMonth() + 1}`.slice(-2);
    const day = `0${date.getDate()}`.slice(-2);
    const filename = `${year}${month}${day}.csv`;
    const filepath = path.join(__dirname, "..", "csv", filename);
    await saveCSVFromObjects(
      results,
      [
        { id: "network", title: "Network" },
        { id: "addr", title: "Address" },
        { id: "award", title: "Award" },
        { id: "gasPercent", title: "Gas%" },
        { id: "gasUsed", title: "All Gas Used" },
        { id: "totalGas", title: "All Gas" },
        { id: "startBlock", title: "Start Block" },
        { id: "endBlock", title: "End Block" },
      ],
      filepath
    );

    console.log(`Calculation result saved at ${filepath}`);
  }

  async resolveTx() {
    let totalGas = new BigNumber(0);
    let gasSubtotals: { [key: string]: BigNumber } = {};
    let bridgeBalances = {};

    for (const config of this.configs) {
      let txs = [];

      let { startBlock, endBlock } = await this.getStartEndBlock(config);

      this.startAndEndBolck[config.network] = {
        startBlock,
        endBlock,
      };

      if (!(config.network in SCAN_APIS)) {
        console.log("NOT SUPPORTED NETWORK: ", Network[config.network]);
        continue;
      }
      const api = SCAN_APIS[config.network];

      console.log("-".repeat(60));
      console.log(`Scanning ${Network[config.network]}`);

      console.log(`Block range: from ${startBlock} to ${endBlock}`);

      txs = await api.getTxsByAccount(config.bridgeAddr, startBlock, endBlock);
      txs = txs.filter(
        (tx) =>
          tx.from.toLowerCase() in this.relayerAddrs ||
          tx.to.toLowerCase() in this.relayerAddrs
      );
      console.log(`#Txns: ${txs.length}`);
      if (config.network === Network.AvalancheMainnet) {
        console.log(
          `Correct gasUsed field for avalanche tx with transaction receipt, #txs: ${txs.length}`
        );
        for (let i in txs) {
          let tx = txs[i];
          const provider = new ethers.providers.JsonRpcProvider(
            config.providerUrl
          );
          console.log(
            `fetching tx receipt for: ${tx.hash}, ${i} of ${txs.length}`
          );
          const avatx = await provider.getTransactionReceipt(tx.hash);
          console.log(`got gasUsed: ${avatx.gasUsed.toString()}`);
          tx.gasUsed = avatx.gasUsed.toString();
        }
      }

      // 获取token价格
      const priceData = await getTokenPrice(config.coinId);
      const price = priceData[config.coinId]["usd"];

      for (const tx of txs) {
        let relayer = "";
        if (tx.from.toLowerCase() in this.relayerAddrs) {
          relayer = tx.from.toLowerCase();
        } else {
          relayer = tx.to.toLowerCase();
        }
        if (!(relayer in gasSubtotals)) {
          gasSubtotals[relayer] = new BigNumber(0);
        }
        const gas = new BigNumber(tx.gasUsed).times(tx.gasPrice);

        const dollorGas = gas.div(UNIT_WEI).times(price);

        gasSubtotals[relayer] = gasSubtotals[relayer].plus(dollorGas);
        totalGas = totalGas.plus(dollorGas);
      }

      const balance = (
        await config.provider.getBalance(config.bridgeAddr)
      ).toString();
      const dollorBalance = new BigNumber(balance).div(UNIT_WEI).times(price);
      bridgeBalances[config.network] = dollorBalance;
      console.log(`Current bridge balance: `, dollorBalance.toString());
    }

    return {
      totalGas,
      gasSubtotals,
      bridgeBalances,
    };
  }

  async getStartEndBlock(c: ChainConfig) {
    let startBlock: Number | String = 0;
    let endBlock: Number | String = "latest";

    switch (c.network) {
      case Network.MeterMainnet:
        startBlock = METER_START_BLOCK;
        endBlock = METER_END_BLOCK;
        break;
      case Network.Ethereum:
        startBlock = ETH_START_BLOCK;
        endBlock = ETH_END_BLOCK;
        break;
      case Network.BSCMainnet:
        startBlock = BSC_START_BLOCK;
        endBlock = BSC_END_BLOCK;
        break;
      case Network.AvalancheMainnet:
        startBlock = AVA_START_BLOCK;
        endBlock = AVA_END_BLOCK;
        break;
      case Network.MoonriverMainnet:
        startBlock = MOONBEAM_START_BLOCK;
        endBlock = MOONBEAM_END_BLOCK;
        break;
      default:
        startBlock = 0;
        endBlock = "latest";
    }

    if (endBlock.toLowerCase() === "latest") {
      endBlock = (await c.provider.getBlockNumber()).toString();
    }

    return {
      startBlock,
      endBlock,
    };
  }

  async stop() {}
}

new RelayerFeeCalculator().start();