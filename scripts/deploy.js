const hre = require("hardhat");
require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');

const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const sendTelegramMessage = (msg) => {
    telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg)
        .catch(err => console.error('Telegram error:', err));
};

async function main() {
    const addressProvider = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"; // Sepolia

    sendTelegramMessage("🏗 Starting contract deployment...");

    const FlashArbitrage = await hre.ethers.getContractFactory("FlashArbitrage");
    const contract = await FlashArbitrage.deploy(addressProvider);

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    const successMsg = `✅ Contract deployed to: ${contractAddress}`;
    console.log(successMsg);
    sendTelegramMessage(successMsg);

    const envMsg = `📝 Add to .env:\nFLASH_ARBITRAGE_CONTRACT=${contractAddress}`;
    console.log(envMsg);
    sendTelegramMessage(envMsg);
}

main().catch((error) => {
    const errorMsg = `⚠️ Deployment failed: ${error.message}`;
    console.error(errorMsg);
    sendTelegramMessage(errorMsg);
    process.exit(1);
});