"use client";

import { useRouter } from "next/navigation";
import styles from "../(auth)/auth.module.css";

export default function LoginPage() {
  const router = useRouter();

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>로그인</h1>
        <p className={styles.subTitle}>회사 계정으로 로그인해 주세요.</p>

        <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
          <label className={styles.label}>이메일</label>
          <input className={styles.input} type="email" placeholder="name@company.com" />

          <label className={styles.label}>비밀번호</label>
          <div className={styles.passwordRow}>
            <input className={styles.input} type="password" placeholder="8자 이상" />
            <button type="button" className={styles.ghostBtn}>표시</button>
          </div>

          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => router.push("/")}
          >
            로그인
          </button>
        </form>

        <div className={styles.bottomText}>
          계정이 없으신가요?{" "}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => router.push("/signup")}
          >
            회원가입
          </button>
        </div>
      </div>
    </div>
  );
}
