import { useState, useEffect } from "react";

export default function HowToUse() {
    const [isStylesLoaded, setIsStylesLoaded] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsStylesLoaded(true);
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    if (!isStylesLoaded) {
        return null;
    }

    return (
        <s-page heading="How To Use">
            <s-box paddingBlockStart="large" paddingBlockEnd="large">
                <s-section heading="How To Use">
                    <s-paragraph>
                        To learn more about how this app works, <a href="/inventory-management.pdf" download target="_blank">click here</a> to download the PDF.
                    </s-paragraph>
                </s-section>
            </s-box>
        </s-page>
    );
}
