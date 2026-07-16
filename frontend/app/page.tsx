'use client'
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import HowToUseEasyPay from "@/components/HowToUse";
import Testimonials from "@/components/Testimonials";
import FAQSection from "@/components/Faq";
import CTA from "@/components/CTA";

export default function Home() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();

  // If the user is already logged in, skip the marketing landing and take
  // them straight to their profile. `replace` avoids trapping the back button.
  useEffect(() => {
    if (ready && authenticated) {
      router.replace("/profile");
    }
  }, [ready, authenticated, router]);

  return (
    <div className="min-h-screen bg-slate-900 text-white overflow-x-hidden w-full">
      <Hero />
      <Features />
      <HowToUseEasyPay />
      <Testimonials />
      <FAQSection />
      <CTA />
    </div>
  );
}