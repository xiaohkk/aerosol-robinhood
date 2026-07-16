"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { usePrivy, useWallets, useSendTransaction } from "@privy-io/react-auth";
import axios from "axios";
import { toast } from "sonner";
import { useParams, useRouter } from "next/navigation";
import { ethers } from "ethers";
import { usePublicClient } from "wagmi";
import { txExplorerUrl, robinhoodChain } from "@/lib/chain";

export default function TransactionApprovalPage() {
  const params = useParams();
  const router = useRouter();
  const transactionId = params?.id as string;
  
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isLoadingTransaction, setIsLoadingTransaction] = useState(true);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const publicClient = usePublicClient();
  const { sendTransaction } = useSendTransaction();
  const [embeddedWallet, setEmbeddedWallet] = useState<any>(null);
  
  const [transaction, setTransaction] = useState<{
    id: string;
    sender: string;
    recipient: string;
    recipientAddress: string;
    amount: number;
    status: 'pending' | 'completed' | 'failed' | 'expired';
  } | null>(null);
  
  const [error, setError] = useState<string | null>(null);

  // Gas reserve held back for fees. Robinhood Chain fees are ~0 (observed
  // < 0.000001 ETH), so a large reserve like 0.001 wrongly blocks small
  // transfers when the wallet balance is itself small.
  const GAS_RESERVE_ETH = 0.0002;

  // Find the Privy embedded wallet when wallets are loaded
  useEffect(() => {
    const privyWallet = wallets.find(wallet => wallet.walletClientType === 'privy');
    setEmbeddedWallet(privyWallet);
  }, [wallets]);

  // Fetch transaction details
  useEffect(() => {
    async function fetchTransactionDetails() {
      if (!transactionId) return;
      try {
        setIsLoadingTransaction(true);
        const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/transactions/${transactionId}`);
        
        if (response.data.success) {
          console.log(response.data.transaction, 'transaction details')
          setTransaction(response.data.transaction);
        } else {
          setError("Failed to load transaction details");
        }
      } catch (error: any) {
        setError(error.response?.data?.error || "Transaction not found or has expired");
        console.error("Error fetching transaction:", error);
      } finally {
        setIsLoadingTransaction(false);
      }
    }
    
    fetchTransactionDetails();
  }, [transactionId]);

  // Fetch wallet balance when wallet is connected
  useEffect(() => {
    const fetchBalance = async () => {
      if (embeddedWallet && user?.wallet?.address && publicClient) {
        try {
          setIsLoadingBalance(true);
          const balance = await publicClient.getBalance({
            address: user.wallet.address as `0x${string}`,
          });
          setWalletBalance(ethers.formatEther(balance));
        } catch (error) {
          console.error("Error fetching wallet balance:", error);
          toast.error("Failed to load wallet balance");
        } finally {
          setIsLoadingBalance(false);
        }
      } else {
        setWalletBalance(null);
      }
    };

    fetchBalance();
    
    // Set up balance refresh on interval
    const refreshInterval = setInterval(fetchBalance, 20000); // Refresh every 20 seconds
    
    return () => clearInterval(refreshInterval);
  }, [publicClient, embeddedWallet, user?.wallet?.address]);

  const handleApprove = async () => {
    if (!embeddedWallet || !user?.wallet?.address || !transaction) {
      toast.error("Please connect your wallet first");
      return;
    }

    console.log(user, transaction, 'approval details')

    if (user?.twitter?.username && user.twitter.username.toLowerCase() !== transaction.sender.toLowerCase()) {
      toast.error("This transaction was requested by a different Twitter account");
      return;
    }

    // Check if amount exceeds available balance
    if (walletBalance !== null && transaction.amount > parseFloat(walletBalance) - GAS_RESERVE_ETH) {
      toast.error("Insufficient balance for transaction (including fees)");
      return;
    }

    console.log('Starting transaction approval process:', {
      transactionId: transaction.id,
      amount: transaction.amount,
      recipientAddress: transaction.recipientAddress,
      walletAddress: user.wallet.address
    });

    setIsLoading(true);
    let hash: string = '';
    
    try {
      const amountInWei = ethers.parseEther(transaction.amount.toString());
      console.log('Amount in wei:', amountInWei.toString());

      console.log('Sending transaction with Privy embedded wallet...');

      // Sign via the Privy embedded wallet directly. The app wraps plain wagmi
      // (no Privy connector), so wagmi's useWalletClient() is always null for
      // the embedded wallet — which is why "connect your wallet first" fired.
      // useSendTransaction() signs through Privy and returns a mined receipt.
      const receipt = await sendTransaction({
        to: transaction.recipientAddress,
        value: '0x' + amountInWei.toString(16),
        chainId: robinhoodChain.id,
      });

      hash = receipt.transactionHash;
      console.log('Transaction sent, hash:', hash);

      if (receipt.status === 0) {
        throw new Error('Transaction failed');
      }

      // Update transaction status on backend
      console.log('Updating transaction status on backend...');
      await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/transactions/complete`, {
        id: transaction.id,
        signature: hash,
        senderAddress: user.wallet.address
      });
      
      // Refresh wallet balance after successful transaction
      const newBalance = await publicClient!.getBalance({
        address: user.wallet.address as `0x${string}`,
      });
      setWalletBalance(ethers.formatEther(newBalance));

      // Create block explorer link
      const explorerUrl = txExplorerUrl(hash);

      toast.success(
        <div className="flex flex-col gap-2">
          <div>Transaction successful!</div>
          <a 
            href={explorerUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-500 underline hover:text-blue-700"
          >
            View transaction on explorer
          </a>
        </div>,
        {
          duration: 6000, 
        }
      );

      // ONLY redirect to profile on successful transaction
      setTimeout(() => {
        router.push(`/profile`);
      }, 2000);
      
    } catch (error) {
      console.error("Error during transaction:", error);
      
      // Even if there was an error in our confirmation process,
      // check if we have a hash and the transaction might have gone through
      if (hash && user?.wallet?.address) {
        const explorerUrl = txExplorerUrl(hash);
        toast.error(
          <div className="flex flex-col gap-2">
            <div>{error instanceof Error ? error.message : "Failed to process transaction"}</div>
            <div className="text-sm">Your transaction might still have gone through.</div>
            <a 
              href={explorerUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-500 underline hover:text-blue-700"
            >
              Check status on explorer
            </a>
          </div>,
          {
            duration: 8000,
          }
        );
        
        // Try to refresh balance even after error, in case transaction went through
        try {
          const refreshedBalance = await publicClient!.getBalance({
            address: user.wallet.address as `0x${string}`,
          });
          setWalletBalance(ethers.formatEther(refreshedBalance));
        } catch (balanceError) {
          console.error("Failed to refresh wallet balance after error:", balanceError);
        }
      } else {
        const errorMessage = error instanceof Error ? error.message : "Failed to process transaction";
        toast.error(errorMessage);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelTransaction = async () => {
    if (!transaction) {
      router.push("/profile");
      return;
    }
    setIsCancelling(true);
    try {
      await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/transactions/cancel`, {
        id: transaction.id,
      });
      toast.success("Request cancelled");
    } catch (error: any) {
      // e.g. already completed — inform, then still leave the screen.
      toast.error(error.response?.data?.error || "Could not cancel this request");
    } finally {
      setIsCancelling(false);
      router.push("/profile");
    }
  };

  if (isLoadingTransaction) {
    return (
      <div className="container mx-auto max-w-md py-12 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-6">Loading Transaction...</h1>
          <div className="animate-spin h-10 w-10 border-4 border-indigo-500 rounded-full border-t-transparent mx-auto"></div>
        </div>
      </div>
    );
  }

  // FIXED: Remove profile redirect from error state
  if (error) {
    return (
      <div className="container mx-auto max-w-md py-12 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-6">Transaction Error</h1>
          <p className="text-red-500 mb-6">{error}</p>
          <div className="space-y-3">
            <Button
              onClick={() => window.location.reload()}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              Try Again
            </Button>
            {/* Removed "Go to Profile" button */}
          </div>
        </div>
      </div>
    );
  }

  // FIXED: Remove profile redirect from transaction not found state
  if (!transaction) {
    return (
      <div className="container mx-auto max-w-md py-12 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-6">Transaction Not Found</h1>
          <p className="text-gray-600 mb-6">This transaction may have expired or been completed.</p>
          <div className="space-y-3">
            <Button
              onClick={() => window.location.reload()}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              Try Again
            </Button>
            {/* Removed "Go to Profile" button */}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-md py-12 px-4">
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="px-6 py-4 bg-indigo-600">
          <h2 className="text-xl font-bold text-white">Approve Transaction</h2>
        </div>
        
        <div className="p-6 text-gray-700">
          <div className="mb-6">
            <p className="text-sm text-gray-500 mb-1">From</p>
            <p className="font-medium ">@{transaction.sender}</p>
          </div>
          
          <div className="mb-4">
            <p className="text-sm text-gray-500 mb-1">To</p>
            <p className="font-medium">@{transaction.recipient}</p>
          </div>
          
          <div className="mb-6 border-b pb-6">
            <p className="text-sm text-gray-500 mb-1">Amount</p>
            <p className="font-bold text-2xl text-indigo-600">{transaction.amount} ETH</p>
          </div>
          
          {embeddedWallet && user?.wallet?.address ? (
            <>
              {walletBalance !== null && (
                <div className="mb-4 p-3 bg-gray-50 rounded">
                  <div className="flex justify-between">
                    <p className="text-sm text-gray-500">Wallet Balance</p>
                    <p className="font-medium">{isLoadingBalance ? "Loading..." : `${parseFloat(walletBalance).toFixed(4)} ETH`}</p>
                  </div>
                  
                  {parseFloat(walletBalance) < transaction.amount + GAS_RESERVE_ETH && (
                    <p className="text-red-500 text-sm mt-2">
                      Insufficient balance for this transaction (including fees)
                    </p>
                  )}
                </div>
              )}
              
              <Button 
                onClick={handleApprove} 
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white mb-4"
                disabled={
                  isLoading || 
                  isLoadingBalance || 
                  (walletBalance !== null && parseFloat(walletBalance) < transaction.amount + GAS_RESERVE_ETH) ||
                  transaction.status !== 'pending'
                }
              >
                {isLoading ? "Processing..." : "Approve & Send"}
              </Button>
              
              {/* Cancels the pending request (marks it cancelled), then leaves */}
              <Button
                onClick={handleCancelTransaction}
                variant="outline"
                className="w-full"
                disabled={isLoading || isCancelling}
              >
                {isCancelling ? "Cancelling…" : "Cancel Request"}
              </Button>
              
              <div className="text-center text-sm text-gray-500 mt-4">
                <p>Using Privy embedded wallet: {user.wallet.address.slice(0, 6)}...{user.wallet.address.slice(-4)}</p>
              </div>
            </>
          ) : (
            <div>
              <p className="text-center text-gray-600 mb-4">
                {!user ? (
                  "Please sign in with your Twitter account"
                ) : (
                  "Connecting to your Privy wallet..."
                )}
              </p>
              
              {!user && (
                <Button 
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={() => router.push("/login")}
                >
                  Sign In with Twitter
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
