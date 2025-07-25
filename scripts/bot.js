/*const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// 1. INFURA CONFIGURATION
const INFURA_CONFIG = {
    sepolia: {
        rpc: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
        chainId: 11155111,
        contracts: {
            aavePool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
            uniswap: {
                router: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
                quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
            },
            sushiswap: {
                router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'
            }
        }
    }
};

// 2. TOKEN CONFIGURATION
const TOKENS = {
    DAI: {
        address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
        decimals: 18
    },
    WETH: {
        address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c',
        decimals: 18
    }
};

// 3. BOT PARAMETERS
const BOT_CONFIG = {
    scanInterval: 120000, // 2 minutes
    minProfit: ethers.parseUnits('0.5', 18), // 0.5 DAI minimum
    maxGasPrice: ethers.parseUnits('25', 'gwei'),
    defaultLoanAmount: ethers.parseUnits('50', 18) // 50 DAI
};

// Initialize providers and contracts
const provider = new ethers.JsonRpcProvider(INFURA_CONFIG.sepolia.rpc);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const telegram = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

class ProductionArbitrageBot {
    constructor() {
        this.contracts = {
            aave: new ethers.Contract(
                INFURA_CONFIG.sepolia.contracts.aavePool,
                ['function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external'],
                wallet
            ),
            uniswap: {
                router: new ethers.Contract(
                    INFURA_CONFIG.sepolia.contracts.uniswap.router,
                    [
                        'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) calldata) external payable returns (uint256 amountOut)'
                    ],
                    wallet
                ),
                quoter: new ethers.Contract(
                    INFURA_CONFIG.sepolia.contracts.uniswap.quoter,
                    [
                        'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
                    ],
                    wallet
                )
            },
            sushiswap: new ethers.Contract(
                INFURA_CONFIG.sepolia.contracts.sushiswap.router,
                [
                    'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
                    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
                ],
                wallet
            )
        };
        this.isActive = false;
    }

    async start() {
        this.isActive = true;
        this.notify('🚀 Production Arbitrage Bot Activated');

        while (this.isActive) {
            try {
                await this.scanAndExecute();
            } catch (error) {
                this.notify(`⚠️ Scan Error: ${error.message}`);
                console.error('Scan error:', error);
            }
            await new Promise(resolve => setTimeout(resolve, BOT_CONFIG.scanInterval));
        }
    }

    async scanAndExecute() {
        console.log(`\n🔍 Scanning at ${new Date().toLocaleTimeString()}`);

        // Get prices from both DEXs
        const [uniPrice, sushiPrice] = await Promise.all([
            this.getUniswapPrice(BOT_CONFIG.defaultLoanAmount),
            this.getSushiswapPrice(BOT_CONFIG.defaultLoanAmount)
        ]);

        // Find arbitrage opportunity
        const opportunity = this.findArbitrageOpportunity(
            BOT_CONFIG.defaultLoanAmount,
            uniPrice,
            sushiPrice
        );

        if (!opportunity) {
            console.log('No profitable opportunities found');
            return;
        }

        this.notify(
            `💰 Opportunity Found\n` +
            `Uniswap: ${ethers.utils.formatUnits(uniPrice, 18)} WETH per ${ethers.utils.formatUnits(BOT_CONFIG.defaultLoanAmount, 18)} DAI\n` +
            `Sushiswap: ${ethers.utils.formatUnits(sushiPrice, 18)} WETH\n` +
            `Expected Profit: ${ethers.utils.formatUnits(opportunity.profit, 18)} DAI`
        );

        // Execute trade
        await this.executeTrade(opportunity);
    }

    async getUniswapPrice(amountIn) {
        try {
            const amountOut = await this.contracts.uniswap.quoter.quoteExactInputSingle(
                TOKENS.DAI.address,
                TOKENS.WETH.address,
                3000, // 0.3% fee tier
                amountIn,
                0
            );
            return amountOut;
        } catch (error) {
            console.error('Uniswap price error:', error);
            throw new Error('Failed to get Uniswap price');
        }
    }

    async getSushiswapPrice(amountIn) {
        try {
            const amounts = await this.contracts.sushiswap.getAmountsOut(
                amountIn,
                [TOKENS.DAI.address, TOKENS.WETH.address]
            );
            return amounts[1];
        } catch (error) {
            console.error('Sushiswap price error:', error);
            throw new Error('Failed to get Sushiswap price');
        }
    }

    findArbitrageOpportunity(amount, uniOutput, sushiOutput) {
        const priceDifference = uniOutput.gt(sushiOutput) ?
            uniOutput.sub(sushiOutput) :
            sushiOutput.sub(uniOutput);

        // Minimum 0.5% price difference
        const minDifference = amount.mul(5).div(1000);

        if (priceDifference.lt(minDifference)) {
            return null;
        }

        const [buyDex, sellDex] = uniOutput.gt(sushiOutput) ?
            ['sushiswap', 'uniswap'] :
            ['uniswap', 'sushiswap'];

        const profit = this.calculateProfit(
            amount,
            buyDex === 'uniswap' ? uniOutput : sushiOutput,
            sellDex === 'uniswap' ? uniOutput : sushiOutput
        );

        if (profit.lt(BOT_CONFIG.minProfit)) {
            return null;
        }

        return {
            amount,
            profit,
            buyDex,
            sellDex
        };
    }

    calculateProfit(amount, buyRate, sellRate) {
        const aaveFee = amount.mul(9).div(10000); // 0.09%
        const expectedReturn = sellRate.mul(buyRate).div(ethers.constants.WeiPerEther);
        return expectedReturn.sub(amount).sub(aaveFee);
    }

    async executeTrade(opportunity) {
        try {
            // Check gas price
            const feeData = await provider.getFeeData();
            if (feeData.gasPrice.gt(BOT_CONFIG.maxGasPrice)) {
                this.notify(`⛽ Gas too high: ${ethers.utils.formatUnits(feeData.gasPrice, 'gwei')} gwei`);
                return false;
            }

            // Prepare transaction
            const calldata = await this.prepareCalldata(opportunity);
            const tx = await this.contracts.aave.flashLoanSimple(
                process.env.FLASH_ARBITRAGE_CONTRACT,
                TOKENS.DAI.address,
                opportunity.amount,
                calldata,
                0,
                { gasPrice: feeData.gasPrice }
            );

            this.notify(
                `⚡ Trade Executed\n` +
                `Amount: ${ethers.utils.formatUnits(opportunity.amount, 18)} DAI\n` +
                `Tx: https://sepolia.etherscan.io/tx/${tx.hash}`
            );

            // Wait for confirmation
            const receipt = await tx.wait();
            const profit = this.parseProfit(receipt.logs);

            if (profit) {
                this.notify(`✅ Success! Profit: ${ethers.utils.formatUnits(profit, 18)} DAI`);
                return true;
            }

            this.notify('⚠️ No profit detected in transaction logs');
            return false;

        } catch (error) {
            this.notify(
                `❌ Trade Failed\n` +
                `Error: ${error.message}\n` +
                `${error.transactionHash ? `Tx: https://sepolia.etherscan.io/tx/${error.transactionHash}` : ''}`
            );
            return false;
        }
    }

    async prepareCalldata(opportunity) {
        const buyRouter = opportunity.buyDex === 'uniswap' ?
            this.contracts.uniswap.router :
            this.contracts.sushiswap;

        const sellRouter = opportunity.sellDex === 'uniswap' ?
            this.contracts.uniswap.router :
            this.contracts.sushiswap;

        // Encode buy transaction
        const buyCalldata = opportunity.buyDex === 'uniswap' ?
            this.contracts.uniswap.router.interface.encodeFunctionData('exactInputSingle', [{
                tokenIn: TOKENS.DAI.address,
                tokenOut: TOKENS.WETH.address,
                fee: 3000,
                recipient: process.env.FLASH_ARBITRAGE_CONTRACT,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: opportunity.amount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }]) :
            this.contracts.sushiswap.interface.encodeFunctionData('swapExactTokensForTokens', [
                opportunity.amount,
                0,
                [TOKENS.DAI.address, TOKENS.WETH.address],
                process.env.FLASH_ARBITRAGE_CONTRACT,
                Math.floor(Date.now() / 1000) + 300
            ]);

        // Encode sell transaction
        const sellCalldata = opportunity.sellDex === 'uniswap' ?
            this.contracts.uniswap.router.interface.encodeFunctionData('exactInputSingle', [{
                tokenIn: TOKENS.WETH.address,
                tokenOut: TOKENS.DAI.address,
                fee: 3000,
                recipient: process.env.FLASH_ARBITRAGE_CONTRACT,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: 0, // Will be set by first swap
                amountOutMinimum: opportunity.amount.add(opportunity.profit),
                sqrtPriceLimitX96: 0
            }]) :
            this.contracts.sushiswap.interface.encodeFunctionData('swapExactTokensForTokens', [
                0, // Will be set by first swap
                opportunity.amount.add(opportunity.profit),
                [TOKENS.WETH.address, TOKENS.DAI.address],
                process.env.FLASH_ARBITRAGE_CONTRACT,
                Math.floor(Date.now() / 1000) + 300
            ]);

        return ethers.utils.defaultAbiCoder.encode(
            ['uint256', 'bytes', 'bytes'],
            [opportunity.profit, buyCalldata, sellCalldata]
        );
    }

    parseProfit(logs) {
        const iface = new ethers.utils.Interface([
            'event ArbitrageProfit(address indexed token, uint256 profit)'
        ]);

        for (const log of logs) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed && parsed.name === 'ArbitrageProfit') {
                    return parsed.args.profit;
                }
            } catch { }
        }
        return null;
    }

    notify(message) {
        console.log(`[${new Date().toISOString()}] ${message}`);
        telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, message)
            .catch(err => console.error('Telegram send failed:', err));
    }
}

// Start the bot
const bot = new ProductionArbitrageBot();
process.on('SIGINT', () => bot.stop());
bot.start().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
*/

const { ethers } = require("ethers");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// Initialize Telegram bot
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const sendTelegramMessage = (msg) => {
    telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg)
        .catch(err => console.error('Telegram error:', err));
};

// Initialize provider
const provider = new ethers.JsonRpcProvider(
    `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`
);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Token addresses on Sepolia
const SEPOLIA_TOKENS = {
    DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
    WETH: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
    USDC: "0xda9d4f9b69ac6C22e444eD9aF0CfC043b7a7f53f"
};

class GasAwareExecutor {
    constructor(targetGwei = 15, maxWaitTime = 120000) {
        this.targetGwei = targetGwei;
        this.maxWaitTime = maxWaitTime;
        this.gasHistory = [];
    }

    async waitForOptimalGas() {
        const startTime = Date.now();
        sendTelegramMessage(`⏳ Starting gas monitoring (Target: ${this.targetGwei} gwei)`);

        while (Date.now() - startTime < this.maxWaitTime) {
            const currentGas = await this.getCurrentGas();
            this.gasHistory.push(currentGas);

            const recentGas = this.gasHistory.slice(-5);
            const avgGas = recentGas.reduce((a, b) => a + b, 0) / recentGas.length;

            const statusMsg = `⛽ Current gas: ${currentGas} | Avg: ${avgGas.toFixed(2)} | Target: ${this.targetGwei}`;
            console.log(statusMsg);

            if (this.gasHistory.length % 3 === 0) {
                sendTelegramMessage(statusMsg);
            }

            if (avgGas <= this.targetGwei) {
                sendTelegramMessage("✅ Optimal gas conditions met");
                return true;
            }

            await new Promise(resolve => setTimeout(resolve, 15000));
        }

        const timeoutMsg = "❌ Timeout waiting for optimal gas";
        sendTelegramMessage(timeoutMsg);
        return false;
    }

    async getCurrentGas() {
        try {
            const feeData = await provider.getFeeData();
            if (!feeData.gasPrice) throw new Error("Gas price not available");
            return parseFloat(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch (error) {
            console.error("Error fetching gas price:", error);
            sendTelegramMessage("⚠️ Error fetching gas price, using fallback");
            return 30;
        }
    }
}

class FlashArbitrageBot {
    constructor() {
        this.gasAware = new GasAwareExecutor(15, 120000);
        this.aavePool = new ethers.Contract(
            process.env.AAVE_POOL_ADDRESS,
            ["function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external"],
            wallet
        );
        this.startTime = new Date();
    }

    async run() {
        try {
            const startupMsg = `🚀 Starting arbitrage bot on Sepolia at ${this.startTime.toLocaleString()}`;
            console.log(startupMsg);
            sendTelegramMessage(startupMsg);

            // Check contract funding
            await this.checkContractFunding();

            if (!(await this.gasAware.waitForOptimalGas())) return;

            const opportunity = await this.findArbitrageOpportunity();
            if (!opportunity) {
                const noOppMsg = "🔍 No profitable opportunity found";
                console.log(noOppMsg);
                sendTelegramMessage(noOppMsg);
                return;
            }

            await this.executeFlashArbitrage(opportunity);

        } catch (error) {
            const errorMsg = `💥 Bot error: ${error.message}`;
            console.error(errorMsg);
            sendTelegramMessage(errorMsg);
        }
    }

    async checkContractFunding() {
        const dai = new ethers.Contract(SEPOLIA_TOKENS.DAI, ["function balanceOf(address)"], wallet);
        const balance = await dai.balanceOf(process.env.FLASH_ARBITRAGE_CONTRACT);

        if (balance < ethers.parseUnits("1", 18)) {
            const fundMsg = "⚠️ Contract needs DAI for fees - funding...";
            console.log(fundMsg);
            sendTelegramMessage(fundMsg);

            // Approve DAI transfer
            const daiWithSigner = dai.connect(wallet);
            await daiWithSigner.approve(process.env.FLASH_ARBITRAGE_CONTRACT, ethers.MaxUint256);

            // Fund contract
            const contract = new ethers.Contract(
                process.env.FLASH_ARBITRAGE_CONTRACT,
                ["function fundContract(address,uint256)"],
                wallet
            );
            const tx = await contract.fundContract(
                SEPOLIA_TOKENS.DAI,
                ethers.parseUnits("10", 18)
            );
            await tx.wait();
            console.log("✅ Contract funded with 10 DAI");
        }
    }

    async findArbitrageOpportunity() {
        // Mock implementation - replace with real DEX comparison
        if (Math.random() > 0.7) {
            return {
                tokenAddress: SEPOLIA_TOKENS.DAI,
                amount: ethers.parseUnits("10", 18), // Start with 10 DAI
                profitEstimate: ethers.parseUnits("0.1", 18), // 0.1 DAI profit
                path: [
                    { dex: '0xYourUniswapRouter', direction: 'DAI->WETH' },
                    { dex: '0xYourSushiswapRouter', direction: 'WETH->DAI' }
                ]
            };
        }
        return null;
    }

    async executeFlashArbitrage(opportunity) {
        const { tokenAddress, amount, profitEstimate, path } = opportunity;

        const executeMsg = `⚡ Executing flash loan for ${ethers.formatUnits(amount, 18)} ${tokenAddress}`;
        console.log(executeMsg);
        sendTelegramMessage(executeMsg);

        const params = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address[]", "bytes[]"],
            [profitEstimate, path.map(p => p.dex), []]
        );

        try {
            const tx = await this.aavePool.flashLoanSimple(
                process.env.FLASH_ARBITRAGE_CONTRACT,
                tokenAddress,
                amount,
                params,
                0
            );

            const txMsg = `📝 Transaction sent: https://sepolia.etherscan.io/tx/${tx.hash}`;
            console.log(txMsg);
            sendTelegramMessage(txMsg);

            const receipt = await tx.wait();
            const confirmMsg = `✅ Transaction confirmed in block: ${receipt.blockNumber}`;
            console.log(confirmMsg);
            sendTelegramMessage(confirmMsg);

            // Parse logs for profit event
            const iface = new ethers.Interface([
                "event ArbitrageProfit(address indexed token, uint256 profit)"
            ]);

            for (const log of receipt.logs) {
                try {
                    const parsed = iface.parseLog(log);
                    if (parsed && parsed.name === "ArbitrageProfit") {
                        const profitMsg = `💰 Profit: ${ethers.formatUnits(parsed.args.profit, 18)} ${parsed.args.token}`;
                        console.log(profitMsg);
                        sendTelegramMessage(profitMsg);
                        break;
                    }
                } catch { }
            }
        } catch (error) {
            const txErrorMsg = `❌ Transaction failed: ${error.message}`;
            console.error(txErrorMsg);
            sendTelegramMessage(txErrorMsg);

            if (error.info?.error?.data) {
                console.error("Revert reason:", error.info.error.data);
            }
        }
    }
}

// Run the bot
process.on('unhandledRejection', (error) => {
    const errorMsg = `⚠️ Unhandled rejection: ${error.message}`;
    console.error(errorMsg);
    sendTelegramMessage(errorMsg);
    process.exit(1);
});

const bot = new FlashArbitrageBot();

setInterval(() => {

    bot.run();
}, 5000);